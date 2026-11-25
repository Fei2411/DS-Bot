import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrast } from '../src/shared/appearance.js'
import { parseVscodeTheme, stripJsonc } from '../src/client/vscode-theme-import.js'

// A real dark VS Code theme, shaped the way they are written: comments, trailing commas,
// an alpha-channel color, and the keys the mapping reads.
const ONE_DARK = `{
  // A comment in the style these files use
  "name": "One Dark Pro",
  "type": "dark",
  "colors": {
    "editor.background": "#282c34",
    "editor.foreground": "#abb2bf",
    "sideBar.background": "#21252b",
    "panel.background": "#1e2227", // trailing comment
    "editorWidget.background": "#21252b",
    "button.background": "#4d78cc",
    "focusBorder": "#3e445200",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#5c6370" } },
  ],
}`

test('JSONC stripping removes comments and trailing commas but leaves strings alone', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ "a": 1, "b": [2, 3,], }')), { a: 1, b: [2, 3] })
  assert.deepEqual(JSON.parse(stripJsonc('{ "url": "https://x//y", "c": "/* z */" }')), { url: 'https://x//y', c: '/* z */' })
  assert.deepEqual(JSON.parse(stripJsonc('{// c\n"a": "\\"quoted, comma\\""}')), { a: '"quoted, comma"' })
  // An unterminated comment or string does not throw here; JSON.parse reports it.
  assert.throws(() => JSON.parse(stripJsonc('{ "a": 1 /* never closed')), SyntaxError)
  // Positions barely move: line structure survives blanking.
  const text = '{\n// note\n"a":1\n}'
  assert.equal(stripJsonc(text).split('\n').length, text.split('\n').length)
})

test('a VS Code theme imports its colors onto the mapped slots', () => {
  const theme = parseVscodeTheme(ONE_DARK)
  assert.equal(theme.label, 'One Dark Pro')
  assert.equal(theme.dark.bg, '#282c34')
  assert.equal(theme.dark.text, '#abb2bf')
  assert.equal(theme.dark.sidebar, '#21252b')
  assert.equal(theme.dark.bubble, '#1e2227')
  assert.equal(theme.dark.card, '#21252b')
  assert.equal(theme.dark.accent, '#4d78cc')
  // focusBorder #3e445200 is fully transparent, so the accent came from button.background,
  // and nothing in the palette carries an alpha channel.
  for (const mode of ['light', 'dark']) {
    for (const key of ['bg', 'text', 'sidebar', 'bubble', 'card', 'user', 'userText', 'accent']) {
      assert.match(theme[mode][key], /^#[0-9a-f]{6}$/, `${mode}.${key}`)
    }
  }
})

test('alpha colors flatten over the canvas', () => {
  const theme = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#ffffff',
      'sideBar.background': '#ffffff80', // half white over black
    },
  }))
  assert.equal(theme.dark.sidebar, '#808080')
  // #rgba expands digit by digit: alpha 0x88 over black, and #fff over #000 is white.
  const short = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: { 'editor.background': '#000', 'sideBar.background': '#fff8' },
  }))
  assert.equal(short.dark.sidebar, '#888888')
  const solid = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: { 'editor.background': '#000', 'sideBar.background': '#ffff' },
  }))
  assert.equal(solid.dark.sidebar, '#ffffff')
})

test('missing slots derive from the canvas and the accent; the other mode flips lightness', () => {
  const theme = parseVscodeTheme(JSON.stringify({ type: 'dark', colors: { 'editor.background': '#282c34' } }))
  assert.equal(theme.dark.bg, '#282c34')
  // Text, surfaces, user bubble and accent all derived, all readable.
  assert.ok(contrast(theme.dark.text, theme.dark.bg) >= 7)
  assert.ok(contrast(theme.dark.userText, theme.dark.user) >= 4.2)
  assert.ok(contrast(theme.dark.text, theme.dark.bubble) >= 4.5)
  // The light side exists, derived from a lightness-flipped canvas of the same hue.
  assert.ok(contrast(theme.light.text, theme.light.bg) >= 7)
  const lum = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).reduce((a, b) => a + b, 0) / 3
  assert.ok(lum(theme.light.bg) > 0.75, `light canvas is light (${lum(theme.light.bg).toFixed(2)})`)
  assert.equal(theme.light.accent, theme.dark.accent, 'the accent carries over')
})

test('light themes read light, and the type field wins over the canvas brightness', () => {
  const light = parseVscodeTheme(JSON.stringify({ type: 'light', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#333333' } }))
  assert.equal(light.light.bg, '#ffffff')
  assert.equal(light.light.text, '#333333')
  // A dark canvas with type light still derives a light-mode arrangement of its own.
  const odd = parseVscodeTheme(JSON.stringify({ type: 'light', colors: { 'editor.background': '#202020' } }))
  assert.ok(contrast(odd.light.text, odd.light.bg) >= 4.5)
  // High-contrast theme type ids count as their base kind.
  const hc = parseVscodeTheme(JSON.stringify({ type: 'hcBlack', colors: { 'editor.background': '#000000' } }))
  assert.equal(hc.dark.bg, '#000000')
  assert.ok(contrast(hc.dark.text, hc.dark.bg) >= 7)
})

test('fallback keys chain in order', () => {
  const theme = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: {
      'editor.background': '#1e1e1e',
      'foreground': '#d4d4d4',
      'activityBar.background': '#252526',
      'editorGroupHeader.tabsBackground': '#252526',
      'dropdown.background': '#3c3c3c',
      'focusBorder': '#007fd4',
    },
  }))
  assert.equal(theme.dark.text, '#d4d4d4', 'foreground when editor.foreground is missing')
  assert.equal(theme.dark.sidebar, '#252526', 'activityBar when sideBar is missing')
  assert.equal(theme.dark.bubble, '#252526', 'tabsBackground when panel is missing')
  assert.equal(theme.dark.card, '#3c3c3c', 'dropdown when editorWidget is missing')
  assert.equal(theme.dark.accent, '#007fd4', 'focusBorder when button.background is missing')
})

test('a file without usable colors is rejected, and so is non-JSON', () => {
  assert.throws(() => parseVscodeTheme('not json at all'), /JSON/)
  assert.throws(() => parseVscodeTheme('[]'), /VS Code theme/)
  assert.throws(() => parseVscodeTheme('{"name": "x"}'), /VS Code theme/)
  assert.throws(() => parseVscodeTheme('{"colors": {}}'), /VS Code theme/)
  assert.throws(() => parseVscodeTheme('{"colors": {"editor.background": "not-a-color"}}'), /VS Code theme/)
  assert.throws(() => parseVscodeTheme('"just a string"'), /VS Code theme/)
  // A nameless theme takes the fallback label; a blank name does too.
  assert.equal(parseVscodeTheme(JSON.stringify({ type: 'dark', colors: { 'editor.background': '#1e1e1e' } }), 'Fallback').label, 'Fallback')
  assert.equal(parseVscodeTheme(JSON.stringify({ type: 'dark', name: '  ', colors: { 'editor.background': '#1e1e1e' } }), 'Fallback').label, 'Fallback')
})

test('tokenColors and other noise are ignored, comments in strings survive', () => {
  const theme = parseVscodeTheme(`{
    "name": "Sole // mate",
    "type": "dark",
    "colors": {
      "editor.background": "#101010",
      "editor.foreground": "#eeeeee",
    },
  }`)
  assert.equal(theme.label, 'Sole // mate')
  assert.equal(theme.dark.bg, '#101010')
})
