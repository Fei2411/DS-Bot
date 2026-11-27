import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrast } from '../src/shared/appearance.js'
import { deriveThemeMode } from '../src/client/themes.js'

// Deriving a whole palette from two colors must never strand the user with unreadable
// text: the canvas decides the mode, the text aims at 7:1 on it, the surfaces step off
// the canvas in order, and your bubble reads its ink off the accent.

const hsl = (hex) => {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  const [hi, lo] = [Math.max(...channels), Math.min(...channels)]
  return (hi + lo) / 2
}

test('a light canvas derives a light mode with dark text at the contrast target', () => {
  const mode = deriveThemeMode('#fcfcfc', '#4d6bfe')
  assert.equal(mode.bg, '#fcfcfc')
  assert.equal(mode.accent, '#4d6bfe')
  assert.ok(contrast(mode.text, mode.bg) >= 7, `text on canvas ${contrast(mode.text, mode.bg).toFixed(2)}:1`)
  for (const surface of ['sidebar', 'bubble', 'card']) {
    assert.ok(contrast(mode.text, mode[surface]) >= 4.5, `text on ${surface} ${contrast(mode.text, mode[surface]).toFixed(2)}:1`)
  }
  // The surfaces step darker away from the canvas; cards float lighter.
  assert.ok(hsl(mode.sidebar) < hsl(mode.bg), 'sidebar darker than canvas')
  assert.ok(hsl(mode.bubble) < hsl(mode.sidebar), 'bubble darker than sidebar')
  assert.ok(hsl(mode.card) >= hsl(mode.bg), 'card not darker than canvas')
  // Your bubble is the accent, its ink the accent's ink.
  assert.equal(mode.user, '#4d6bfe')
  assert.ok(contrast(mode.userText, mode.user) >= 4.2, `userText on user ${contrast(mode.userText, mode.user).toFixed(2)}:1`)
})

test('a dark canvas derives a dark mode with light text', () => {
  const mode = deriveThemeMode('#141414', '#ff8a2e')
  assert.ok(contrast(mode.text, mode.bg) >= 7, `text on canvas ${contrast(mode.text, mode.bg).toFixed(2)}:1`)
  assert.ok(hsl(mode.sidebar) > hsl(mode.bg), 'sidebar lighter than canvas')
  assert.ok(hsl(mode.bubble) > hsl(mode.sidebar), 'bubble lighter than sidebar')
  assert.ok(hsl(mode.card) > hsl(mode.bg), 'card lighter than canvas')
  assert.ok(contrast(mode.text, mode.bubble) >= 4.5)
})

test('a tinted canvas keeps its hue in the surfaces', () => {
  const mode = deriveThemeMode('#2a1e3c', '#c084fc')
  const hueOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    const [hi, lo] = [Math.max(r, g, b), Math.min(r, g, b)]
    if (hi === lo) return 0
    const d = hi - lo
    const h = hi === r ? 60 * (((g - b) / d) % 6) : hi === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
    return h < 0 ? h + 360 : h
  }
  const hue = hueOf('#2a1e3c')
  for (const surface of ['sidebar', 'bubble', 'card']) {
    const diff = Math.abs(hueOf(mode[surface]) - hue)
    assert.ok(Math.min(diff, 360 - diff) < 2, `${surface} keeps the hue (off by ${diff.toFixed(3)}°)`)
  }
})

test('on a mid-tone canvas the text strengthens to the most readable endpoint', () => {
  // Pure black and pure white both reach only about 4.8:1 on #767676; the better one wins.
  const mode = deriveThemeMode('#767676', '#4d6bfe')
  assert.equal(mode.text, '#000000')
  assert.ok(contrast(mode.text, mode.bg) >= 4.5)
  // A canvas on the lightness boundary still derives coherently.
  for (const canvas of ['#757575', '#767676', '#777777', '#808080', '#7f7f7f']) {
    for (const forced of [undefined, 'light', 'dark']) {
      const boundary = deriveThemeMode(canvas, '#4d6bfe', forced)
      for (const surface of ['bg', 'sidebar', 'bubble', 'card']) {
        assert.ok(contrast(boundary.text, boundary[surface]) >= 4.5, `${canvas} (${forced ?? 'auto'}) ${surface} contrast=${contrast(boundary.text, boundary[surface]).toFixed(2)}`)
      }
    }
  }
})

test('the appearance argument forces the mode instead of the canvas lightness', () => {
  const dark = deriveThemeMode('#fcfcfc', '#4d6bfe', 'dark')
  // A forced dark mode on a light canvas steps the surfaces up, not down.
  assert.ok(hsl(dark.sidebar) > hsl(dark.bg))
  const light = deriveThemeMode('#141414', '#4d6bfe', 'light')
  assert.ok(hsl(light.sidebar) < hsl(light.bg))
  assert.equal(deriveThemeMode('#FFFFFF', '#ABCDEF').bg, '#ffffff', 'colors normalize to lowercase')
  assert.throws(() => deriveThemeMode('red', '#4d6bfe'), TypeError)
  assert.throws(() => deriveThemeMode('#fcfcfc', '#fff'), TypeError)
})

test('a bright accent gets dark ink on your bubble, a deep one white ink', () => {
  assert.equal(deriveThemeMode('#fcfcfc', '#ffe600').userText, '#141414')
  assert.equal(deriveThemeMode('#fcfcfc', '#4d6bfe').userText, '#ffffff')
  // Either way the ink reads on the bubble.
  for (const accent of ['#ffe600', '#4d6bfe', '#f4f4f4', '#0d0d0d']) {
    const mode = deriveThemeMode('#fcfcfc', accent)
    assert.ok(contrast(mode.userText, mode.user) >= 4.2, accent)
  }
})
