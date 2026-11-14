import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrastRatio, MIN_SKIN_ALPHA, over, parseColor, readSkinSurfaceVars, skinSurfaceVars, SKIN_VARIABLES, writeSkinSurfaceVars } from '../src/client/skin.js'
import { themeVars } from '../src/client/themes.js'
import { THEMES } from './skin-themes.js'

// public#1507: a third-party skin's glass sliders write DSH's background tokens; DS Bot's
// own surfaces use the theme colors. These tests keep the bridge honest: nothing changes
// while the tokens are opaque, a translucent token reaches exactly the surfaces named, the
// alpha floor holds, and the theme's text keeps its contrast over the wallpaper behind.

test('theme colors parse as hex, short hex and rgba, and anything else is unreadable', () => {
  assert.deepEqual(parseColor('#f2f2f2'), { r: 242, g: 242, b: 242, a: 1 })
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseColor('#11223344'), { r: 17, g: 34, b: 51, a: 0x44 / 255 })
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.6)'), { r: 10, g: 20, b: 30, a: 0.6 })
  assert.equal(parseColor('rgb(10,20,30)')?.a, 1)
  assert.equal(parseColor('var(--dsw-static-neutral-50)'), undefined)
  assert.equal(parseColor('inherit'), undefined)
  assert.equal(parseColor(''), undefined)
})

test('an opaque token changes nothing, and each translucent token moves its own surfaces', () => {
  const colors = { main: '#fcfcfc', sidebar: '#f7f7f7', card: '#ffffff' }
  // DS Bot writes these tokens itself when it applies a theme: solid, so the theme stays.
  assert.deepEqual(skinSurfaceVars({ main: '#fcfcfc', sidebar: '#f7f7f7', colors }), {})
  assert.deepEqual(skinSurfaceVars({ main: 'rgb(20,20,20)', sidebar: 'rgb(27,27,27)', colors }), {})
  // The canvas token reaches the pane, the cards and the composer glass.
  const canvas = skinSurfaceVars({ main: 'rgba(252,252,252,0.5)', sidebar: '#f7f7f7', colors })
  assert.deepEqual(Object.keys(canvas).sort(), ['--bt-skin-card', '--bt-skin-main'])
  assert.ok(Math.abs(parseColor(canvas['--bt-skin-main']).a - 0.7) < 0.005)
  assert.deepEqual([parseColor(canvas['--bt-skin-card']).r, parseColor(canvas['--bt-skin-card']).g, parseColor(canvas['--bt-skin-card']).b], [255, 255, 255])
  // The sidebar token is its own surface, and does not move the canvas.
  const side = skinSurfaceVars({ main: '#fcfcfc', sidebar: 'rgba(247,247,247,0.4)', colors })
  assert.deepEqual(Object.keys(side), ['--bt-skin-sidebar'])
  assert.ok(Math.abs(parseColor(side['--bt-skin-sidebar']).a - 0.7) < 0.005)
})

test('the alpha floor is a floor, not a cap: a nearly opaque token keeps its own alpha', () => {
  const colors = { main: '#101010', sidebar: '#181818', card: '#202020' }
  const vars = skinSurfaceVars({ main: 'rgba(16,16,16,0.92)', sidebar: 'rgba(24,24,24,0.85)', colors })
  assert.ok(Math.abs(parseColor(vars['--bt-skin-main']).a - 0.92) < 0.01, vars['--bt-skin-main'])
  assert.ok(Math.abs(parseColor(vars['--bt-skin-sidebar']).a - 0.85) < 0.01, vars['--bt-skin-sidebar'])
  assert.equal(MIN_SKIN_ALPHA, 0.7)
})

test('every theme keeps its text contrast at the alpha floor over a white, black or mid-tone wallpaper', () => {
  for (const [id, theme] of Object.entries(THEMES)) {
    for (const mode of ['light', 'dark']) {
      const colors = theme[mode]
      for (const wallpaper of ['#ffffff', '#000000', '#5b6b7d']) {
        for (const surface of ['bg', 'sidebar']) {
          const shown = over(parseColor(colors[surface]), MIN_SKIN_ALPHA, wallpaper)
          const ratio = contrastRatio(parseColor(colors.text), shown)
          assert.ok(ratio >= 4.5, `${id} ${mode} ${surface} over ${wallpaper}: ${ratio.toFixed(2)}:1`)
        }
      }
    }
  }
})

test('the theme surfaces ask for the skin variables and keep the theme color as the fallback', () => {
  const light = THEMES.deepseek.light
  const vars = themeVars(light, false)
  assert.equal(vars['--bt-main'], `var(--bt-skin-main, ${light.bg})`)
  assert.equal(vars['--bt-sidebar'], `var(--bt-skin-sidebar, ${light.sidebar})`)
  assert.equal(vars['--bt-card'], `var(--bt-skin-card, ${light.card})`)
  // Text and the other colors never take a skin alpha.
  assert.equal(vars['--bt-ink'], light.text)
  assert.equal(vars['--bt-bubble'], light.bubble)
})

test('the bridge writes the body properties while a token is translucent and removes them after', () => {
  const makeDoc = (tokens) => ({
    body: { style: { values: new Map(), setProperty(name, value) { this.values.set(name, value) }, removeProperty(name) { this.values.delete(name) } }, hasAttribute: () => false },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: name => tokens[name] ?? '' }) },
  })
  const theme = THEMES.deepseek
  // A translucent canvas and sidebar from a skin.
  const doc = makeDoc({ '--dsw-alias-bg-base': 'rgba(252,252,252,0.4)', '--dsw-specific-sidebar-fill': 'rgba(247,247,247,0.4)' })
  const bridge = writeSkinSurfaceVars(doc, () => readSkinSurfaceVars(doc, theme))
  bridge.apply()
  assert.deepEqual([...doc.body.style.values.keys()].sort(), [...SKIN_VARIABLES].sort())
  // The skin turned off: the tokens are opaque again, so the body goes back to the theme.
  doc.defaultView.getComputedStyle = () => ({ getPropertyValue: name => (name === '--dsw-alias-bg-base' ? '#fcfcfc' : '#f7f7f7') })
  bridge.apply()
  assert.deepEqual([...doc.body.style.values.keys()], [])
  bridge.apply()
  bridge.clear()
  assert.deepEqual([...doc.body.style.values.keys()], [])
})
