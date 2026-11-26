// Reading a VS Code theme file (.json with // comments, /* */ comments and trailing
// commas -- JSONC) into one of the team's own themes. VS Code themes name colors for the
// editor's parts; the ones that have a counterpart here are taken over, the rest of the
// eight are derived from the canvas and the accent (themes.js deriveThemeMode). The mode
// the file is not written for is derived from a lightness-flipped canvas, so a dark VS
// Code theme still has a matching light side.
import { cleanTheme, contrast, luminanceOf, READABLE } from '../shared/appearance.js'
import { deriveThemeMode, VSCODE_DEFAULTS } from './themes.js'

// One pass over JSONC text with a callback for what sits at each position. Strings are
// read exactly, escapes included, so a comma or a comment marker inside a string is text.
function walkJsonc(source, visit) {
  const n = source.length
  let i = 0
  while (i < n) {
    const ch = source[i]
    if (ch === '"') {
      let end = i + 1
      while (end < n) {
        if (source[end] === '\\') { end = Math.min(end + 2, n); continue }
        if (source[end] === '"') { end += 1; break }
        end += 1
      }
      visit('string', i, end)
      i = end
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      let end = i
      while (end < n && source[end] !== '\n') end += 1
      visit('comment', i, end)
      i = end
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      visit('comment', i, end)
      i = end
      continue
    }
    visit('char', i, i + 1)
    i += 1
  }
}

/**
 * JSONC as JSON: comments blanked to spaces (so tokens on either side never merge), then
 * trailing commas dropped. Two passes because the comma's lookahead must see past where a
 * comment used to be. Positions are kept throughout, so error positions barely move.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  let uncommented = source.slice()
  walkJsonc(source, (kind, start, end) => {
    if (kind !== 'comment') return
    // Newlines inside the comment stay, so line positions never move.
    uncommented = uncommented.slice(0, start) + source.slice(start, end).replace(/[^\n]/g, ' ') + uncommented.slice(end)
  })
  let out = uncommented
  walkJsonc(uncommented, (kind, start, end) => {
    if (kind !== 'char' || uncommented[start] !== ',') return
    let j = end
    while (j < uncommented.length && /\s/.test(uncommented[j])) j += 1
    if (uncommented[j] === '}' || uncommented[j] === ']') out = out.slice(0, start) + ' ' + out.slice(end)
  })
  return out
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const channelsOf = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
const toHex = rgb => `#${rgb.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`

/** A #rgb / #rgba / #rrggbb / #rrggbbaa color as #rrggbb, alpha composited over the canvas. */
function flattenColor(value, canvas) {
  if (typeof value !== 'string' || !HEX.test(value)) return undefined
  let hex = value.toLowerCase()
  if (hex.length === 4 || hex.length === 5) hex = `#${hex.slice(1).split('').map(ch => ch + ch).join('')}`
  if (hex.length === 7) return hex
  const alpha = parseInt(hex.slice(7, 9), 16) / 255
  // Nearly invisible: flattening it would reproduce the canvas itself, so it reads as unset.
  if (alpha < 0x20 / 255) return undefined
  return toHex(channelsOf(hex).map((channel, index) => channel * alpha + channelsOf(canvas)[index] * (1 - alpha)))
}

// hue/saturation/lightness, for the lightness flip of the other mode's canvas.
const hslOf = (hex) => {
  const [r, g, b] = channelsOf(hex).map(value => value / 255)
  const [hi, lo] = [Math.max(r, g, b), Math.min(r, g, b)]
  const l = (hi + lo) / 2
  if (hi === lo) return [0, 0, l]
  const d = hi - lo
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = hi === r ? 60 * (((g - b) / d) % 6) : hi === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
  return [h < 0 ? h + 360 : h, s, l]
}
const hexOfHsl = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return toHex(rgb.map(value => (value + m) * 255))
}

// Where each of the eight colors is read from in a VS Code theme, in order of preference.
const MAP = {
  bg: ['editor.background'],
  text: ['editor.foreground', 'foreground'],
  sidebar: ['sideBar.background', 'activityBar.background'],
  bubble: ['panel.background', 'editorGroupHeader.tabsBackground'],
  card: ['editorWidget.background', 'dropdown.background'],
  accent: ['button.background', 'focusBorder', 'textLink.foreground'],
}

/**
 * Parse a VS Code theme file.
 * @param {string} text - the file's text, JSONC
 * @param {string} [fallbackLabel] - the theme's name when the file names none
 * @returns {{ label: string, light: object, dark: object }} one user theme, both modes
 * @throws {Error} when the text is not JSONC, has no colors at all, or yields an unusable canvas
 */
export function parseVscodeTheme(text, fallbackLabel = 'VS Code theme') {
  let parsed
  try { parsed = JSON.parse(stripJsonc(text)) } catch { throw new Error('This file is not JSON') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('This file is not a VS Code theme')
  const colors = parsed.colors
  if (colors === null || typeof colors !== 'object' || Array.isArray(colors)) throw new Error('This file is not a VS Code theme')

  const rawType = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : ''
  // Legacy high-contrast themes are the dark kind; only hclight is light.
  const typeDark = rawType === 'dark' || rawType === 'hcblack' || rawType === 'hc' ? true : rawType === 'light' || rawType === 'hclight' ? false : undefined
  // The canvas is the bottom-most surface: there is nothing under it to composite with,
  // so a visible alpha color drops its alpha channel while a nearly transparent value
  // (< 0x20, matching flattenColor) reads as unset and falls back to the mode default
  // instead of turning a transparent light theme into solid black.
  const opaque = (value) => {
    if (typeof value !== 'string' || !HEX.test(value)) return undefined
    let hex = value.toLowerCase()
    if (hex.length === 4 || hex.length === 5) hex = `#${hex.slice(1).split('').map(ch => ch + ch).join('')}`
    if (hex.length === 9 && parseInt(hex.slice(7, 9), 16) < 0x20) return undefined
    return hex.slice(0, 7)
  }
  const explicitCanvas = opaque(colors['editor.background'])
  // When neither type nor a visible canvas is supplied, pick the mode whose fallback canvas
  // gives the highest actual post-compositing WCAG contrast (using flattenColor rather than
  // raw alpha-stripped RGB or perceptual-blind HSL lightness).
  const inferredDark = () => {
    let fallbackFgDark
    for (const name of MAP.text) {
      const rawFg = colors[name]
      if (opaque(rawFg) === undefined) continue
      const onDark = flattenColor(rawFg, VSCODE_DEFAULTS.dark)
      const onLight = flattenColor(rawFg, VSCODE_DEFAULTS.light)
      const darkScore = onDark ? contrast(onDark, VSCODE_DEFAULTS.dark) : 0
      const lightScore = onLight ? contrast(onLight, VSCODE_DEFAULTS.light) : 0
      if (Math.max(darkScore, lightScore) >= READABLE) return darkScore >= lightScore
      if (fallbackFgDark === undefined) fallbackFgDark = darkScore >= lightScore
    }
    const darkInk = deriveThemeMode(VSCODE_DEFAULTS.dark, VSCODE_DEFAULTS.accent, 'dark').text
    const lightInk = deriveThemeMode(VSCODE_DEFAULTS.light, VSCODE_DEFAULTS.accent, 'light').text
    let fallbackSurfaceDark
    for (const name of [...MAP.sidebar, ...MAP.bubble, ...MAP.card]) {
      const rawSurface = colors[name]
      if (opaque(rawSurface) === undefined) continue
      const onDark = flattenColor(rawSurface, VSCODE_DEFAULTS.dark)
      const onLight = flattenColor(rawSurface, VSCODE_DEFAULTS.light)
      const darkScore = onDark ? contrast(onDark, darkInk) : 0
      const lightScore = onLight ? contrast(onLight, lightInk) : 0
      if (Math.max(darkScore, lightScore) >= READABLE) return darkScore >= lightScore
      if (fallbackSurfaceDark === undefined) fallbackSurfaceDark = darkScore >= lightScore
    }
    if (fallbackSurfaceDark !== undefined) return fallbackSurfaceDark
    if (fallbackFgDark !== undefined) return fallbackFgDark
    return true
  }
  // The file's type decides the mode; a visible canvas's perceptual contrast (white vs black)
  // decides next via WCAG luminance without hardcoded hex literals; otherwise infer.
  const isPerceptuallyDark = (hex) => {
    const l = luminanceOf(hex) + 0.05
    return 1.05 / l >= l / 0.05
  }
  const dark = typeDark ?? (explicitCanvas !== undefined ? isPerceptuallyDark(explicitCanvas) : inferredDark())
  const canvas = explicitCanvas ?? (dark ? VSCODE_DEFAULTS.dark : VSCODE_DEFAULTS.light)

  // A colors dictionary without a single visible color is not a theme: every slot would
  // come out of thin air.
  if (!Object.values(colors).some(value => opaque(value) !== undefined)) {
    throw new Error('This file is not a VS Code theme')
  }

  const accent = MAP.accent.map(key => flattenColor(colors[key], canvas)).find(Boolean) ?? VSCODE_DEFAULTS.accent
  const mode = deriveThemeMode(canvas, accent, dark ? 'dark' : 'light')
  const firstSuppliedText = MAP.text.map(name => flattenColor(colors[name], canvas)).find(Boolean)
  const readableText = MAP.text
    .map(name => flattenColor(colors[name], canvas))
    .find(color => color !== undefined && contrast(color, canvas) >= READABLE)
  if (readableText !== undefined) mode.text = readableText
  // If a supplied foreground failed readability and was replaced with a different text color,
  // only apply imported surfaces that stay readable against the final text color; otherwise
  // keep the readable surfaces deriveThemeMode produced for it.
  const textReplaced = firstSuppliedText !== undefined && firstSuppliedText !== mode.text
  for (const key of ['sidebar', 'bubble', 'card']) {
    const found = MAP[key]
      .map(name => flattenColor(colors[name], canvas))
      .find(color => color !== undefined && (!textReplaced || contrast(mode.text, color) >= READABLE))
    if (found !== undefined) mode[key] = found
    else if (textReplaced && contrast(mode.text, mode[key]) < READABLE) mode[key] = canvas
  }

  // The other mode is derived from the same canvas flipped in lightness: the file says
  // nothing about it, and this keeps its hue and its accent rather than inventing both.
  const flipped = hexOfHsl(...(() => { const [h, s, l] = hslOf(canvas); return [h, s, 1 - l] })())
  const other = deriveThemeMode(flipped, mode.accent, dark ? 'light' : 'dark')

  const label = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : fallbackLabel
  return cleanTheme({ label, light: dark ? other : mode, dark: dark ? mode : other })
}
