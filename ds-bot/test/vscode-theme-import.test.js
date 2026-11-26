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

test('trailing commas before comments still strip, in both comment styles', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ "x": 1, // note\n }')), { x: 1 })
  assert.deepEqual(JSON.parse(stripJsonc('{ "x": 1, /* note */ }')), { x: 1 })
  assert.deepEqual(JSON.parse(stripJsonc('{ "x": [1, 2,], // note\n "y": 3, }')), { x: [1, 2], y: 3 })
  // A comma before a comment before a value is a real comma and stays.
  assert.deepEqual(JSON.parse(stripJsonc('{ "x": [1, // note\n 2] }')), { x: [1, 2] })
})

test('nearly transparent colors read as unset instead of flattening to the canvas', () => {
  const theme = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#eeeeee',
      'button.background': '#ff000000', // fully transparent: must not become a black accent
      'focusBorder': '#00ff0010',       // 16/255 alpha: below the visibility floor
      'textLink.foreground': '#0000ff40', // 64/255 alpha: real color, flattens
    },
  }))
  assert.equal(theme.dark.accent, '#000040', 'the only visible accent candidate, flattened, wins')
  assert.notEqual(theme.dark.accent, '#000000', 'a transparent accent never flattens to the canvas')
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
  // High-contrast theme type ids count as their base kind; legacy plain "hc" is the dark one.
  const hc = parseVscodeTheme(JSON.stringify({ type: 'hcBlack', colors: { 'editor.background': '#000000' } }))
  assert.equal(hc.dark.bg, '#000000')
  assert.ok(contrast(hc.dark.text, hc.dark.bg) >= 7)
  const legacyHc = parseVscodeTheme(JSON.stringify({ type: 'hc', colors: { 'editor.background': '#000000', 'editor.foreground': '#ffffff' } }))
  assert.equal(legacyHc.dark.bg, '#000000')
  assert.equal(legacyHc.dark.text, '#ffffff', 'legacy hc is high-contrast dark, not light')
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
  assert.equal(theme.dark.user, '#007fd4', 'imported accent drives the user message bubble in the imported mode too')
  assert.equal(theme.light.user, '#007fd4', 'and in the derived opposite mode')
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

test('transparent editor.background falls back to the mode default canvas instead of black, and all-transparent color dicts are rejected', () => {
  // Light glass/transparent theme with #00000000 canvas must stay readable on a light canvas,
  // never stripping alpha to solid black (#000000).
  const lightGlass = parseVscodeTheme(JSON.stringify({
    name: 'Light Glass',
    type: 'light',
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#1f2328',
    },
  }))
  assert.notEqual(lightGlass.light.bg, '#000000')
  assert.ok(contrast(lightGlass.light.text, lightGlass.light.bg) >= 7, `light glass text must remain readable on light canvas (${lightGlass.light.bg})`)
  assert.equal(lightGlass.light.text, '#1f2328')

  // Without a type field and with a transparent/missing background, infer light vs dark from
  // foreground contrast so dark text never lands on the dark fallback canvas.
  const untypedLightGlass = parseVscodeTheme(JSON.stringify({
    name: 'Untyped Light Glass',
    colors: {
      'editor.background': '#ffffff00',
      'editor.foreground': '#1f2328',
    },
  }))
  assert.notEqual(untypedLightGlass.light.bg, '#1e1e1e')
  assert.equal(untypedLightGlass.light.text, '#1f2328')
  assert.ok(contrast(untypedLightGlass.light.text, untypedLightGlass.light.bg) >= 7, 'untyped transparent light theme stays readable in light mode')
  assert.ok(contrast(untypedLightGlass.dark.text, untypedLightGlass.dark.bg) >= 7, 'derived opposite mode also stays readable')

  const untypedDarkGlass = parseVscodeTheme(JSON.stringify({
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#d4d4d4',
    },
  }))
  assert.equal(untypedDarkGlass.dark.text, '#d4d4d4')
  assert.ok(contrast(untypedDarkGlass.dark.text, untypedDarkGlass.dark.bg) >= 7, 'untyped transparent dark theme picks dark fallback canvas')

  // Saturated dark-blue sidebar with no type/canvas/foreground uses perceptual contrast
  // (not HSL lightness) so it imports into dark mode with readable light text.
  const blueSidebar = parseVscodeTheme(JSON.stringify({
    colors: {
      'editor.background': '#00000000',
      'sideBar.background': '#3030df',
    },
  }))
  assert.equal(blueSidebar.dark.sidebar, '#3030df')
  assert.ok(contrast(blueSidebar.dark.text, blueSidebar.dark.sidebar) >= 4.5, 'saturated blue sidebar receives dark mode with readable text')

  // Translucent foreground that composites below WCAG readability keeps the derived ink
  // rather than replacing it with unreadable pale gray text.
  const translucentFg = parseVscodeTheme(JSON.stringify({
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#00000060',
    },
  }))
  assert.ok(contrast(translucentFg.light.text, translucentFg.light.bg) >= 4.5, 'unreadable translucent foreground falls back to derived readable ink in light mode')
  assert.ok(contrast(translucentFg.dark.text, translucentFg.dark.bg) >= 4.5, 'dark mode also remains readable')

  // When editor.foreground is unreadable on both default canvases, mode inference continues
  // to the fallback `foreground` key and picks the mode where it is readable.
  const fallbackFg = parseVscodeTheme(JSON.stringify({
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#cc33ff88',
      'foreground': '#d4d4d4',
    },
  }))
  assert.equal(fallbackFg.dark.text, '#d4d4d4')
  assert.ok(contrast(fallbackFg.dark.text, fallbackFg.dark.bg) >= 7)

  // When a supplied foreground fails canvas contrast and gets replaced by derived text,
  // imported surfaces that clash with the replacement text are skipped in favor of derived ones.
  const midtoneClash = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: {
      'editor.background': '#777777',
      'editor.foreground': '#ffffff',
      'sideBar.background': '#202020',
      'panel.background': '#202020',
    },
  }))
  assert.ok(contrast(midtoneClash.dark.text, midtoneClash.dark.bg) >= 4.5)
  assert.ok(contrast(midtoneClash.dark.text, midtoneClash.dark.sidebar) >= 4.5, 'sidebar remains readable with replacement text')
  assert.ok(contrast(midtoneClash.dark.text, midtoneClash.dark.bubble) >= 4.5, 'bubble remains readable with replacement text')

  // When a fallback `foreground` replaces `editor.foreground` and an imported surface fails
  // readability, a derived surface that clashes with that fallback text falls back to `canvas`.
  const fallbackSurfaceClash = parseVscodeTheme(JSON.stringify({
    type: 'dark',
    colors: {
      'editor.background': '#757575',
      'editor.foreground': '#777777',
      'foreground': '#000000',
      'panel.background': '#747474',
    },
  }))
  assert.equal(fallbackSurfaceClash.dark.text, '#000000')
  assert.ok(contrast(fallbackSurfaceClash.dark.text, fallbackSurfaceClash.dark.bg) >= 4.5)
  assert.ok(contrast(fallbackSurfaceClash.dark.text, fallbackSurfaceClash.dark.bubble) >= 4.5, 'retained bubble falls back to canvas when derived bubble fails readability')
  assert.ok(contrast(fallbackSurfaceClash.dark.text, fallbackSurfaceClash.dark.sidebar) >= 4.5)
  assert.ok(contrast(fallbackSurfaceClash.dark.text, fallbackSurfaceClash.dark.card) >= 4.5)

  // Shorthand 4-digit transparent #0000 also falls back to mode default.
  const shortGlass = parseVscodeTheme(JSON.stringify({
    type: 'light',
    colors: { 'editor.background': '#0000', 'editor.foreground': '#222222' },
  }))
  assert.notEqual(shortGlass.light.bg, '#000000')
  assert.ok(contrast(shortGlass.light.text, shortGlass.light.bg) >= 7)

  // A colors map containing only invisible transparent placeholders has no usable colors.
  assert.throws(() => parseVscodeTheme(JSON.stringify({
    type: 'light',
    colors: { 'editor.background': '#00000000', 'focusBorder': '#0000', 'foreground': '#11223310' },
  })), /VS Code theme/)

  // UTF-8 BOM prefixed JSONC parses cleanly.
  const bom = parseVscodeTheme(`\uFEFF${ONE_DARK}`)
  assert.equal(bom.label, 'One Dark Pro')
  assert.equal(bom.dark.bg, '#282c34')
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
