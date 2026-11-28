// Main process integration test for window bounds persistence, multi-display restoration,
// and active-conversation window title updates.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, startApp, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  // Pre-seed bounds from an external display that is no longer connected, with maximized: true.
  writeFileSync(
    join(paths.userData, 'window-bounds.json'),
    JSON.stringify({ x: 3000, y: 200, width: 1100, height: 740, maximized: true }),
  )
  await startApp()
})

test('main window restores clamped bounds on primary display and applies saved maximized state on hand-off', async () => {
  await waitFor(() => window() !== undefined, 'open the team window')
  const win = window()
  // Fake display is 1920x1040 at (0,0); off-screen (3000,200) is centered on primary.
  assert.deepEqual(win.getBounds(), { x: 410, y: 150, width: 1100, height: 740 })

  hostState.release()
  await handOff()
  assert.equal(win.isMaximized(), true, 'saved maximized state is restored after hand-off')
})

test('page-title-updated allows DS Bot conversation titles and blocks arbitrary titles', () => {
  const win = window()

  let prevented = false
  win.emit('page-title-updated', { preventDefault: () => { prevented = true } }, 'Chief — DS Bot')
  assert.equal(prevented, false, 'conversation title is allowed through')

  prevented = false
  win.emit('page-title-updated', { preventDefault: () => { prevented = true } }, 'DS Bot')
  assert.equal(prevented, false, 'plain DS Bot title is allowed through')

  prevented = false
  win.emit('page-title-updated', { preventDefault: () => { prevented = true } }, 'http://127.0.0.1:41234/')
  assert.equal(prevented, true, 'raw URL title is still prevented')
})

test('moving and resizing persists window-bounds.json and rebuilding the window restores it', async () => {
  const win = window()
  win.unmaximize()
  win.setBounds({ x: 180, y: 120, width: 1020, height: 680 })
  win.emit('move')
  win.emit('resize')
  // Closing hides to tray and flushes bounds immediately.
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')

  const saved = JSON.parse(readFileSync(join(paths.userData, 'window-bounds.json'), 'utf8'))
  assert.deepEqual(saved, { x: 180, y: 120, width: 1020, height: 680, maximized: false })

  // Destroy the window and reopen from tray -> rebuilt window inherits persisted bounds.
  win.destroy()
  trayMenu()[0].click()
  await waitFor(() => teamWindows().length === 2, 'rebuild the team window')
  const second = window()
  assert.deepEqual(second.getBounds(), { x: 180, y: 120, width: 1020, height: 680 })

  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'quit the app')
})
