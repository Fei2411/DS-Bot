import { ACCENT_INKS, INKS, isHex, luminance } from './inks.js'
import { SHAPES, markupCache, maskCache } from './characters.js'
import { createSource } from './sources.js'
import { BASE_KEYS, cleanTheme, contrast, READABLE, THEME_KEYS, USER_THEME } from '../shared/appearance.js'
import { FONT_RANGES, FONT_ROUTE, REPLY_FACES, REPLY_FAMILY } from '../shared/reply-fonts.js'

// -------------------------------------------------------------------------
// Themes. A theme names eight colors per mode; every `--bt-*` variable and the shell
// tokens derive from them, so a registered theme recolors the whole team UI.

// Bot replies in the bundled serif: Source Serif 4 for Latin, Noto Serif SC for Chinese.
// DSH resolves its Markdown font tokens on body, so rebinding --dsw-font-family here
// would not reach them; the reply sets font-family on the Markdown root, headings and
// table cells instead, which DSH draws with `font` shorthands. Only the Markdown is set:
// the bubble also holds interface parts (the fold note and button). The model picker's
// greeting is plain text in a bubble that stands for the Bot's first message, so it is set
// too. Code keeps its own family, and a text font the user set in Settings still wins.
const fontFace = ({ file, style, weight, range }) => `@font-face{font-family:"${REPLY_FAMILY}";src:url(${FONT_ROUTE}/${file}) format("woff2");font-style:${style};font-weight:${weight};font-display:swap;unicode-range:${FONT_RANGES[range]}}`
export const SERIF_REPLIES = `${REPLY_FACES.map(fontFace).join('\n')}
.bt-look-bot,.bt-model-dock .bt-bubble,.bt-bubble [class*="_markdown"],.bt-bubble [class*="_markdown"] :is(h1,h2,h3,h4,h5,h6,th,td){font-family:var(--dsh-font-family-text,"${REPLY_FAMILY}","Source Han Serif SC","Noto Serif CJK SC","Songti SC"),var(--dsh-font-family-text-default,sans-serif)}`
const THEMES = {
  deepseek: {
    label: 'DeepSeek',
    light: { bg: '#fcfcfc', sidebar: '#f7f7f7', bubble: '#eeeeee', card: '#ffffff', text: '#141414', user: '#070707', userText: '#fcfcfc', accent: '#4d6bfe' },
    dark: { bg: '#141414', sidebar: '#1b1b1b', bubble: '#262626', card: '#1f1f1f', text: '#f2f2f2', user: '#f2f2f2', userText: '#141414', accent: '#4d6bfe' },
  },
  mono: {
    label: 'Mono',
    light: { bg: '#ffffff', sidebar: '#f9f9f9', bubble: '#f0f0f0', card: '#ffffff', text: '#0d0d0d', user: '#0d0d0d', userText: '#ffffff', accent: '#0d0d0d' },
    dark: { bg: '#0f0f0f', sidebar: '#171717', bubble: '#242424', card: '#1c1c1c', text: '#f4f4f4', user: '#f4f4f4', userText: '#0f0f0f', accent: '#f4f4f4' },
  },
  paper: {
    label: 'Paper',
    light: { bg: '#faf9f5', sidebar: '#f3f0e8', bubble: '#ebe7dc', card: '#ffffff', text: '#1f1e1b', user: '#2b2a26', userText: '#faf9f5', accent: '#d97757' },
    dark: { bg: '#1f1e1b', sidebar: '#262521', bubble: '#34322d', card: '#2a2925', text: '#f3f0e8', user: '#f3f0e8', userText: '#1f1e1b', accent: '#e08a6d' },
  },
  moonlight: {
    label: 'Moonlight',
    light: { bg: '#f7f9fc', sidebar: '#eef2f8', bubble: '#e5ebf5', card: '#ffffff', text: '#121826', user: '#1e3a8a', userText: '#ffffff', accent: '#1e86ff' },
    dark: { bg: '#0b1020', sidebar: '#10172a', bubble: '#1a2340', card: '#141c33', text: '#e8edf7', user: '#3b6fd8', userText: '#ffffff', accent: '#4f9dff' },
  },
  fei: {
    label: 'Fei',
    light: { bg: '#faf6ee', sidebar: '#f3ede2', bubble: '#efe8db', card: '#fdfbf7', text: '#211f1b', user: '#e2eeec', userText: '#163f46', accent: '#1e8294' },
    dark: { bg: '#1d1c19', sidebar: '#23221e', bubble: '#2d2b26', card: '#27251f', text: '#f2ede3', user: '#1f4a51', userText: '#e6f1f0', accent: '#3fa9ba' },
    css: SERIF_REPLIES,
  },
}
// Text on the accent: prefer crisp white whenever it reads cleanly (>= 4.2:1, e.g. DeepSeek blue);
// fall back to near-black only on genuinely bright accents (such as Mono dark #f4f4f4).
const DARK_INK = '#141414'
const accentInk = accent => (contrast('#ffffff', accent) >= 4.2
  ? '#ffffff'
  : (luminance(accent) + 0.05) ** 2 > 1.05 * (luminance(DARK_INK) + 0.05) ? DARK_INK : '#ffffff')
const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')},${alpha})`
// While a background shows (appearance.js): one wash of the main color at the chosen
// opacity lies over the picture, and the page panes on top of it are clear (`--bt-pane`,
// DSH's base fill). DSH nests several panes on the same base color, so panes that each let
// the picture through would stack into a solid color again. Floating surfaces on the main
// color (Settings, panels, docks) stay nearly solid, so they read over the page; the sidebar
// keeps a light tint of its own color, cards stay nearly solid.
const SIDEBAR_TINT = 0.4
const FLOATING = 0.94
const round = alpha => Math.round(alpha * 100) / 100
export const washColor = (mode, alpha) => rgba(mode.bg, alpha)
export const surfaceVars = (mode, alpha) => `--bt-pane:transparent;--bt-wash:${washColor(mode, alpha)};--bt-skin-main:${rgba(mode.bg, FLOATING)};--bt-skin-sidebar:${rgba(mode.sidebar, SIDEBAR_TINT)};--bt-skin-card:${rgba(mode.card, round(Math.max(FLOATING, alpha + 0.06)))}`
export const surfaceColors = theme => ({ light: { bg: 'transparent', sidebar: rgba(theme.light.sidebar, SIDEBAR_TINT) }, dark: { bg: 'transparent', sidebar: rgba(theme.dark.sidebar, SIDEBAR_TINT) } })
export const veilColors = alpha => ({ light: rgba('#ffffff', alpha), dark: rgba('#000000', alpha) })
// Where a new background starts when the user picks its kind (appearance-page.js).
export const BACKGROUND_STARTS = { color: { light: '#dfe6f5', dark: '#1d2433' }, from: '#9ab6ff', to: '#f7c6d9' }
// What a VS Code theme that names no usable editor background or accent falls back to
// (vscode-theme-import.js): the canvas of VS Code's own default themes, and the blue of
// its default button, which is also DeepSeek's accent.
export const VSCODE_DEFAULTS = { dark: '#1e1e1e', light: '#ffffff', accent: '#4d6bfe' }
// The basic colors (Settings → Appearance): a new background or text color moves the other
// surfaces with it. Each surface keeps its place between background and text, channel by
// channel, so a theme's tint (Paper's warm sidebar) carries over. Your bubble and its text
// follow the text and background when they were near them, and keep their own color when
// the theme gave them one (Moonlight's blue).
const channels = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
const toHex = rgb => `#${rgb.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`
const distance = (a, b) => Math.max(...channels(a).map((value, index) => Math.abs(value - channels(b)[index])))
// Which basic color a bubble color sat on, if any: the nearer one within 24 a channel.
const anchorOf = (color, mode) => {
  const [toText, toBg] = [distance(color, mode.text), distance(color, mode.bg)]
  if (Math.min(toText, toBg) > 24) return undefined
  return toText <= toBg ? 'text' : 'bg'
}
// A channel where background and text are this close says nothing about a surface's place.
const SPAN = 16
/**
 * @param {object} mode - a theme's eight colors for one mode
 * @param {{ bg?: string, text?: string }} change
 * @returns {object} the mode with the change and the surfaces that follow it
 */
export function followBasics(mode, change) {
  const next = { ...mode, ...change }
  const [bg, text, newBg, newText] = [mode.bg, mode.text, next.bg, next.text].map(channels)
  const spans = bg.map((value, index) => text[index] - value)
  for (const key of ['sidebar', 'bubble', 'card']) {
    const at = channels(mode[key]).map((value, index) => (Math.abs(spans[index]) >= SPAN ? (value - bg[index]) / spans[index] : undefined))
    const known = at.filter(value => value !== undefined)
    if (known.length === 0) continue
    const mean = known.reduce((sum, value) => sum + value, 0) / known.length
    next[key] = toHex(at.map((value, index) => newBg[index] + (value ?? mean) * (newText[index] - newBg[index])))
  }
  // Your bubble and its text never land on the same color: when both sat on one basic color,
  // both keep their own.
  const [user, userText] = [anchorOf(mode.user, mode), anchorOf(mode.userText, mode)]
  if (user !== userText || user === undefined) {
    if (user !== undefined) next.user = next[user]
    if (userText !== undefined) next.userText = next[userText]
  }
  // One of the pair keeps its own color (Moonlight's blue bubble): the other one follows
  // whichever basic color reads on it, when the one it sat on no longer does.
  const basics = [next.bg, next.text]
  const readOn = other => basics.reduce((best, color) => (contrast(color, other) > contrast(best, other) ? color : best))
  if (user === undefined && userText !== undefined && contrast(next.userText, next.user) < READABLE) next.userText = readOn(next.user)
  if (userText === undefined && user !== undefined && contrast(next.user, next.userText) < READABLE) next.user = readOn(next.userText)
  return next
}
/**
 * The colors with a new background or text color, the other surfaces placed as they sat in
 * the colors before the first of a run of such changes. Those are kept with the colors
 * (`base`), so a background that passes close to the text on its way loses nothing, also
 * when the change after it comes another day. A color set on its own drops `base`.
 * @param {object} colors - one mode of a theme, maybe with its `base`
 * @param {{ bg?: string, text?: string }} change
 */
export function moveBasics(colors, change) {
  const base = colors.base ?? Object.fromEntries(BASE_KEYS.map(key => [key, colors[key]]))
  const moved = followBasics({ ...colors, ...base }, { bg: colors.bg, text: colors.text, ...change })
  return { ...colors, ...Object.fromEntries(BASE_KEYS.map(key => [key, moved[key]])), base }
}
// Deriving a whole mode from two picked colors (the canvas and the accent, in Settings →
// Appearance): the surfaces are small lightness steps off the canvas in the mode's
// direction, the text is as soft as the contrast target allows, and your bubble takes the
// accent with the same ink the accent buttons use.
const hslOf = (hex) => {
  const [r, g, b] = channels(hex).map(value => value / 255)
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
const toward = (from, to, ratio) => toHex(channels(from).map((value, index) => value + (channels(to)[index] - value) * ratio))
// Readable text starts soft (the built-in themes' inks); on a mid-tone canvas, where even
// pure black or pure white barely reads, it strengthens toward the pure endpoint.
const TEXT_TARGET = 7
const readableOn = (ink, canvas) => {
  const pure = contrast('#000000', canvas) >= contrast('#ffffff', canvas) ? '#000000' : '#ffffff'
  if (contrast(ink, canvas) >= TEXT_TARGET) return ink
  for (let step = 1; step <= 6; step += 1) {
    const moved = toward(ink, pure, step / 6)
    if (contrast(moved, canvas) >= TEXT_TARGET) return moved
  }
  return pure
}
/**
 * The eight colors of one mode derived from a canvas and an accent.
 * @param {string} canvasHex - the main background, `#rrggbb`
 * @param {string} accentHex - the accent, `#rrggbb`
 * @param {'light' | 'dark'} [appearance] - force a mode; by default the canvas's lightness decides
 * @returns {{ accent: string, bg: string, text: string, sidebar: string, bubble: string, card: string, user: string, userText: string }}
 */
export function deriveThemeMode(canvasHex, accentHex, appearance) {
  if (!isHex(canvasHex) || !isHex(accentHex)) throw new TypeError('A canvas and an accent as #rrggbb colors')
  const canvas = canvasHex.toLowerCase()
  const accent = accentHex.toLowerCase()
  const [hue, saturation, lightness] = hslOf(canvas)
  const dark = appearance === undefined ? lightness < 0.5 : appearance === 'dark'
  const step = (delta) => hexOfHsl(hue, saturation, Math.min(1, Math.max(0, lightness + delta)))
  const text = readableOn(dark ? '#f2f2f2' : '#141414', canvas)
  // Surfaces step off the canvas in the mode's direction; on a mid-tone canvas where a
  // step toward the chosen text drops below READABLE, step the same distance away instead.
  const awaySign = contrast(text, '#000000') > contrast(text, '#ffffff') ? -1 : 1
  const surface = (delta) => {
    const preferred = step(delta)
    if (contrast(text, preferred) >= READABLE) return preferred
    return step(awaySign * Math.abs(delta))
  }
  return {
    accent,
    bg: canvas,
    text,
    sidebar: surface(dark ? 0.03 : -0.03),
    bubble: surface(dark ? 0.075 : -0.075),
    // Cards float a little lighter than the canvas in both modes.
    card: surface(0.045),
    user: accent,
    userText: accentInk(accent),
  }
}
export function themeVars(mode, dark, accent = mode.accent) {
  return {
    '--bt-ink': mode.text, '--bt-ink-2': rgba(mode.text, 0.6), '--bt-ink-3': rgba(mode.text, 0.36),
    '--bt-bubble': mode.bubble, '--bt-sidebar': `var(--bt-skin-sidebar, ${mode.sidebar})`,
    '--bt-main': `var(--bt-skin-main, ${mode.bg})`, '--bt-card': `var(--bt-skin-card, ${mode.card})`,
    '--bt-line': rgba(mode.text, 0.08), '--bt-line-2': rgba(mode.text, 0.15),
    '--bt-hover': dark ? 'rgba(160,160,160,.12)' : 'rgba(119,119,119,.09)',
    '--bt-active': dark ? 'rgba(160,160,160,.2)' : 'rgba(119,119,119,.17)',
    '--bt-accent': accent, '--bt-accent-ink': accentInk(accent),
    '--bt-user': mode.user, '--bt-user-ink': mode.userText,
    '--bt-tag-bg': rgba(mode.text, dark ? 0.09 : 0.06), '--bt-tag-ink': rgba(mode.text, 0.58),
    // Warning text and icon: readable on the card in both modes (ui-standard 2.3).
    '--bt-warn': dark ? '#f0b84a' : '#8a5a00',
  }
}
const declarations = vars => Object.entries(vars).map(([name, value]) => `${name}:${value}`).join(';')
// A preset accent is saved as its light value; in dark mode it takes the preset's dark
// value, as Bot names do, so Charcoal does not vanish on a dark background. A custom
// accent is the same in both modes. A preset is matched the way Settings marks it.
const darkAccent = (accent) => {
  const ink = ACCENT_INKS.find(id => INKS[id][0] === accent)
  return ink === undefined ? accent : INKS[ink][1]
}
/** The accent a mode shows: the team's accent when one is picked, else the theme's. */
export const accentIn = (theme, modeName, accent) => (modeName === 'dark' ? darkAccent(accent) : accent) ?? theme[modeName].accent
// `html body` outranks the base sheet's `body` rules without !important.
export const themeCss = (theme, accent) => `html body{${declarations(themeVars(theme.light, false, accent ?? theme.light.accent))}}
html body[data-ds-dark-theme]{${declarations(themeVars(theme.dark, true, darkAccent(accent) ?? theme.dark.accent))}}
${theme.css ?? ''}`
// `surfaces` replaces the base and sidebar fills, so a background shows through DSH's frame too.
export const shellTokens = ({ light, dark }, surfaces = { light, dark }) => ({
  '--dsw-alias-bg-base': { light: surfaces.light.bg, dark: surfaces.dark.bg },
  '--dsw-specific-sidebar-fill': { light: surfaces.light.sidebar, dark: surfaces.dark.sidebar },
  '--dsw-specific-input-major': { light: light.bg, dark: dark.sidebar },
  '--dsw-alias-label-primary': { light: light.text, dark: dark.text },
  '--dsw-alias-label-secondary': { light: rgba(light.text, 0.74), dark: rgba(dark.text, 0.74) },
  '--dsw-alias-label-tertiary': { light: rgba(light.text, 0.6), dark: rgba(dark.text, 0.6) },
})

// Other plugins add character shapes and themes through `window.dshBot`, or queue
// calls on `window.dshBotQueue` before this plugin loads. A shape draws only its
// body; the eyes are cut out where `eyes.at` says, so it gets every state motion free.
const customThemes = {}
export const registry = createSource(0)
const isPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
export function registerShape(id, shape) {
  if (typeof id !== 'string' || !/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Shape ids are lowercase words')
  if (typeof shape?.body !== 'function' || typeof shape.body('#000') !== 'string') throw new Error('A shape needs body(paint) returning SVG markup')
  const at = shape.eyes?.at
  if (!Array.isArray(at) || at.length !== 2 || !at.every(isPoint)) throw new Error('A shape needs eyes.at: two [x, y] points')
  const size = Number.isFinite(shape.size) && shape.size > 0 ? shape.size : 100
  const pick = (key, fallback) => (Number.isFinite(shape.eyes[key]) ? shape.eyes[key] : fallback)
  const eyes = at.map(([x, y]) => [x, y, pick('w', size * 0.1), pick('h', size * 0.23), pick('tilt', -27)])
  const previous = SHAPES[id]
  SHAPES[id] = {
    label: String(shape.label ?? id),
    size,
    body: shape.body,
    eyes,
    ...(typeof shape.wrap === 'string' ? { wrap: shape.wrap } : {}),
  }
  const refresh = () => {
    markupCache.clear()
    maskCache.clear()
    registry.set(value => value + 1)
  }
  refresh()
  return () => {
    if (previous) SHAPES[id] = previous
    else delete SHAPES[id]
    refresh()
  }
}
export function registerTheme(id, theme) {
  if (typeof id !== 'string' || !/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Theme ids are lowercase words')
  for (const mode of ['light', 'dark']) {
    for (const key of THEME_KEYS) if (!isHex(theme?.[mode]?.[key])) throw new Error(`Theme ${mode}.${key} must be a #rrggbb color`)
  }
  const previous = customThemes[id]
  customThemes[id] = { label: String(theme.label ?? id), light: theme.light, dark: theme.dark, css: typeof theme.css === 'string' ? theme.css : '' }
  registry.set(value => value + 1)
  return () => {
    if (previous) customThemes[id] = previous
    else delete customThemes[id]
    registry.set(value => value + 1)
  }
}
export const allThemes = () => ({ ...THEMES, ...customThemes })
// The team's own themes (`prefs.themes`, ids `my-…`) after the built-in and plugin ones. A
// saved theme that no longer passes the rules is left out, so it falls back to the default.
export function themesOf(prefs) {
  const own = {}
  for (const [id, theme] of Object.entries(prefs?.themes ?? {})) {
    if (!USER_THEME.test(id)) continue
    try { own[id] = { ...cleanTheme(theme), own: true } } catch { /* unusable: left out */ }
  }
  return { ...allThemes(), ...own }
}

// How chat messages are drawn; a value the plugin does not know reads as the default.
// A width is a percent of the column: the bubbles' in either layout, the text's in the
// flat one.
export const MESSAGE_WIDTH = { min: 50, max: 100, step: 5 }
const percent = (value, initial) => (Number.isInteger(value) && value >= MESSAGE_WIDTH.min && value <= MESSAGE_WIDTH.max ? value : initial)
export const layoutOf = prefs => (prefs?.layout === 'flat' ? 'flat' : 'bubble')
export const effectsOf = prefs => (prefs?.effects === 'reduced' || prefs?.effects === 'off' ? prefs.effects : 'full')
export const thinkingShown = prefs => prefs?.thinking === true
export const widthOf = prefs => percent(prefs?.width, 80)
export const flatWidthOf = prefs => percent(prefs?.flatWidth, 100)
