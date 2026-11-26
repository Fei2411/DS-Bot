import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { CAPTION_HEIGHT, cssColor, frameOptions, framelessOn, keepVibrancy, materialOf, nativeThemeSource } from '../src/window-frame.mjs'

test('Mica only on Windows 11 22H2 and later, the vibrancy on macOS', () => {
  assert.equal(materialOf('win32', '10.0.22621'), 'mica')
  assert.equal(materialOf('win32', '10.0.26100'), 'mica')
  assert.equal(materialOf('win32', '10.0.22000'), undefined)
  assert.equal(materialOf('win32', '10.0.19045'), undefined)
  assert.equal(materialOf('darwin', '25.0.0'), 'vibrancy')
  assert.equal(materialOf('linux', '6.8.0'), undefined)
})

test('Windows and macOS draw the page under their window controls; Linux keeps its title bar', () => {
  assert.equal(framelessOn('win32'), true)
  assert.equal(framelessOn('darwin'), true)
  assert.equal(framelessOn('linux'), false)
  const caption = { color: '#f9fafb', symbolColor: '#0f1115' }
  assert.deepEqual(frameOptions('win32', 'mica', caption), { titleBarStyle: 'hidden', titleBarOverlay: { height: CAPTION_HEIGHT, ...caption }, backgroundMaterial: 'mica' })
  assert.deepEqual(frameOptions('win32', undefined, caption), { titleBarStyle: 'hidden', titleBarOverlay: { height: CAPTION_HEIGHT, ...caption } })
  const mac = frameOptions('darwin', 'vibrancy', caption)
  assert.equal(mac.titleBarStyle, 'hidden')
  assert.equal(mac.vibrancy, 'sidebar')
  assert.equal(mac.titleBarOverlay, undefined)
  // The 14 px traffic lights sit in the middle of the band.
  assert.equal(mac.trafficLightPosition.y * 2 + 14, CAPTION_HEIGHT)
  assert.deepEqual(frameOptions('linux', undefined, caption), {})
})

test('a minimized or hidden macOS window paints the fill until the vibrancy is back', () => {
  const win = Object.assign(new EventEmitter(), {
    minimized: false, visible: true, calls: [],
    isDestroyed: () => false, isMinimized() { return this.minimized }, isVisible() { return this.visible },
    setVibrancy(value) { this.calls.push(['vibrancy', value]) }, setBackgroundColor(value) { this.calls.push(['background', value]) },
  })
  keepVibrancy(win, () => '#f9fafb')
  win.minimized = true
  win.emit('minimize')
  assert.deepEqual(win.calls.splice(0), [['vibrancy', null], ['background', '#f9fafb']])
  win.minimized = false
  win.emit('restore')
  assert.deepEqual(win.calls.splice(0), [['vibrancy', 'sidebar'], ['background', '#00000000']])
  win.visible = false
  win.emit('hide')
  assert.deepEqual(win.calls.splice(0), [['vibrancy', null], ['background', '#f9fafb']])
})

test('only plain CSS colors reach the caption buttons', () => {
  assert.equal(cssColor('rgba(252, 252, 252, 1)'), true)
  assert.equal(cssColor('rgb(20, 20, 20)'), true)
  assert.equal(cssColor('#f9fafb'), true)
  assert.equal(cssColor('red'), false)
  assert.equal(cssColor('url(x)'), false)
  assert.equal(cssColor(7), false)
})

test('a theme id does not reach the native theme', () => {
  assert.equal(nativeThemeSource('dark'), 'dark')
  assert.equal(nativeThemeSource('system'), 'system')
  assert.equal(nativeThemeSource('moonlight'), undefined)
  assert.equal(nativeThemeSource(null), undefined)
})
