// The team's appearance beyond the theme: user themes, shape, density, background, fonts and a
// user stylesheet. The host checks every change with these rules before it saves one, and
// the windows read saved values with the same rules, so a value the host would refuse
// never reaches the page (docs/plans/2026-11-21-appearance.md).

export const THEME_KEYS = ['bg', 'sidebar', 'bubble', 'card', 'text', 'user', 'userText', 'accent']
// The colors a new background or text color moves; the accent stays.
export const BASE_KEYS = ['bg', 'text', 'sidebar', 'bubble', 'card', 'user', 'userText']
export const MAX_USER_THEMES = 32
export const USER_THEME = /^my-[a-z0-9-]{1,28}$/
export const RADIUS = { min: 0, max: 200, initial: 100, step: 10 }
export const DENSITIES = ['compact', 'standard', 'roomy']
export const FONT_SIZE = { min: 12, max: 20, initial: 14 }
export const LINE_HEIGHT = { min: 1.3, max: 2, initial: 1.6 }
export const BLUR = { min: 0, max: 40 }
export const DIM = { min: 0, max: 80 }
// The floor keeps theme ink at 5:1 or more over a pure white or pure black picture for all
// four built-in themes (see client/skin.js, MIN_SKIN_ALPHA).
export const SURFACE = { min: 70, max: 100, initial: 88 }
export const FITS = ['cover', 'contain', 'tile']
export const MODES = ['light', 'dark', 'system']
export const MAX_CSS = 64 * 1024
export const MAX_FONT = 200
export const MAX_BACKGROUND_BYTES = 12 * 1024 * 1024
export const IMAGE_ID = /^[0-9a-f]{64}$/
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const HEX = /^#[0-9a-f]{6}$/i
// A font list is CSS text placed inside a declaration: nothing that can end it or open
// another rule.
const FONT_TEXT = /^[^;{}<>\\\p{Cc}]*$/u

/** The size of text in UTF-8 bytes, where TextEncoder may be missing. */
export function utf8Length(text) {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export class AppearanceError extends Error {}
const refuse = message => { throw new AppearanceError(message) }

const isHex = value => typeof value === 'string' && HEX.test(value)
const whole = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max
const inRange = (value, { min, max }) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/**
 * One user theme as the host keeps it.
 * @param {unknown} theme - `{ label, light: {…8 colors}, dark: {…8 colors} }`
 * @returns {{ label: string, light: Record<string, string>, dark: Record<string, string> }}
 */
export function cleanTheme(theme) {
  if (theme === null || typeof theme !== 'object') refuse('A theme needs a name and its light and dark colors')
  const label = String(theme.label ?? '').trim().slice(0, 40)
  if (label === '') refuse('A theme needs a name')
  const out = { label }
  for (const mode of ['light', 'dark']) {
    out[mode] = {}
    for (const key of THEME_KEYS) {
      const color = theme[mode]?.[key]
      if (!isHex(color)) refuse(`Theme ${mode}.${key} must be a #rrggbb color`)
      out[mode][key] = color.toLowerCase()
    }
    // The colors the surfaces were placed from when the background or text last moved them
    // (client/themes.js moveBasics); one that is not whole is left out.
    const base = theme[mode]?.base
    if (base !== undefined && base !== null && typeof base === 'object' && BASE_KEYS.every(key => isHex(base[key]))) {
      out[mode].base = Object.fromEntries(BASE_KEYS.map(key => [key, base[key].toLowerCase()]))
    }
  }
  return out
}

/**
 * A chat or team background.
 * @param {unknown} value
 * @returns {object} the background with only the fields its kind uses
 */
export function cleanBackground(value) {
  if (value === null || typeof value !== 'object') refuse('A background needs a kind')
  const common = {}
  if (value.blur !== undefined) {
    if (!whole(value.blur, BLUR)) refuse(`Blur is a whole number from ${BLUR.min} to ${BLUR.max}`)
    if (value.blur > 0) common.blur = value.blur
  }
  if (value.dim !== undefined) {
    if (!whole(value.dim, DIM)) refuse(`Dim is a whole percent from ${DIM.min} to ${DIM.max}`)
    if (value.dim > 0) common.dim = value.dim
  }
  if (value.surface !== undefined) {
    if (!whole(value.surface, SURFACE)) refuse(`Surface opacity is a whole percent from ${SURFACE.min} to ${SURFACE.max}`)
    common.surface = value.surface
  }
  switch (value.kind) {
    case 'color':
      if (!isHex(value.color)) refuse('A color background needs a #rrggbb color')
      return { kind: 'color', color: value.color.toLowerCase(), ...common }
    case 'gradient':
      if (!isHex(value.from) || !isHex(value.to)) refuse('A gradient needs two #rrggbb colors')
      if (value.angle !== undefined && !whole(value.angle, { min: 0, max: 359 })) refuse('The gradient angle is a whole number from 0 to 359')
      return { kind: 'gradient', from: value.from.toLowerCase(), to: value.to.toLowerCase(), angle: value.angle ?? 180, ...common }
    case 'image':
      if (typeof value.image !== 'string' || !IMAGE_ID.test(value.image)) refuse('An image background needs a saved picture')
      if (value.fit !== undefined && !FITS.includes(value.fit)) refuse(`Fit is one of ${FITS.join(', ')}`)
      return { kind: 'image', image: value.image, ...(value.fit && value.fit !== 'cover' ? { fit: value.fit } : {}), ...common }
    default:
      return refuse('A background is a color, a gradient or an image')
  }
}

const fontText = (value, what) => {
  if (typeof value !== 'string' || value.length > MAX_FONT || !FONT_TEXT.test(value) || /\/\*|\*\//.test(value)) refuse(`${what} is a list of font names, separated by commas`)
  return value.trim()
}

// CSS's own family keywords, written without quotes.
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'])
/**
 * A saved font list as CSS: each family quoted on its own, so no name can end the
 * declaration or open a comment, whatever quotes the user typed.
 * @param {string} value
 * @returns {string}
 */
export function fontStack(value) {
  return String(value ?? '').split(',')
    .map(name => name.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter(Boolean)
    .map(name => (GENERIC.has(name.toLowerCase()) ? name.toLowerCase() : `"${name.replace(/[\\"]/g, '\\$&')}"`))
    .join(',')
}

// Each field of an appearance change and how it is kept. `null` removes a field, so it reads as
// its default again; a default value is not stored either.
const FIELDS = {
  radius: (value) => {
    if (!whole(value, RADIUS)) refuse(`Corner size is a whole percent from ${RADIUS.min} to ${RADIUS.max}`)
    return value === RADIUS.initial ? undefined : value
  },
  density: (value) => {
    if (!DENSITIES.includes(value)) refuse(`Density is one of ${DENSITIES.join(', ')}`)
    return value === 'standard' ? undefined : value
  },
  background: cleanBackground,
  css: (value) => {
    if (typeof value !== 'string') refuse('The stylesheet must be text')
    if (utf8Length(value) > MAX_CSS) refuse(`The stylesheet holds at most ${MAX_CSS / 1024} KB`)
    return value.trim() === '' ? undefined : value
  },
  mode: (value) => {
    if (!MODES.includes(value)) refuse(`Appearance is one of ${MODES.join(', ')}`)
    return value === 'system' ? undefined : value
  },
  uiFont: value => fontText(value, 'The interface font') || undefined,
  codeFont: value => fontText(value, 'The code font') || undefined,
  fontSize: (value) => {
    if (!whole(value, FONT_SIZE)) refuse(`Font size is a whole number from ${FONT_SIZE.min} to ${FONT_SIZE.max}`)
    return value === FONT_SIZE.initial ? undefined : value
  },
  lineHeight: (value) => {
    if (!inRange(value, LINE_HEIGHT)) refuse(`Line height is from ${LINE_HEIGHT.min} to ${LINE_HEIGHT.max}`)
    const rounded = Math.round(value * 20) / 20
    return rounded === LINE_HEIGHT.initial ? undefined : rounded
  },
  material: (value) => {
    if (typeof value !== 'boolean') refuse('Window material is on or off')
    return value ? undefined : false
  },
}
export const APPEARANCE_FIELDS = Object.keys(FIELDS)
// Window-level appearance: color mode, fonts, text metrics, material and CSS draw the
// computer's own window rather than the shared team look. CSS can also fetch remote
// resources. Paired devices keep the team-facing fields but may not change these.
export const COMPUTER_APPEARANCE_FIELDS = new Set(['css', 'mode', 'uiFont', 'codeFont', 'fontSize', 'lineHeight', 'material'])

/**
 * Apply a change to the saved appearance. Fields the change does not name stay as they are.
 * @param {Record<string, unknown> | undefined} current - the saved appearance
 * @param {unknown} patch - `{ field: value | null }`
 * @returns {Record<string, unknown>} the new appearance; empty when every field is its default
 * @throws {AppearanceError} when a field is unknown or its value is not allowed
 */
export function patchAppearance(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) refuse('An appearance change names its fields')
  const next = { ...current }
  for (const [field, value] of Object.entries(patch)) {
    const clean = FIELDS[field]
    if (clean === undefined) refuse(`Unknown appearance field: ${field}`)
    const kept = value === null ? undefined : clean(value)
    if (kept === undefined) delete next[field]
    else next[field] = kept
  }
  return next
}

/**
 * A saved appearance as it can be used: fields that no longer pass the rules (written by
 * another version, or by hand) are dropped instead of breaking the page.
 * @param {unknown} appearance
 * @returns {Record<string, unknown>}
 */
export function readAppearance(appearance) {
  const out = {}
  if (appearance === null || typeof appearance !== 'object') return out
  for (const [field, value] of Object.entries(appearance)) {
    try {
      const kept = FIELDS[field]?.(value)
      if (kept !== undefined) out[field] = kept
    } catch { /* an unusable field reads as its default */ }
  }
  return out
}

/** @returns {string[]} the ids of the pictures these backgrounds use */
export function backgroundImages(...backgrounds) {
  return backgrounds.flatMap(background => (background?.kind === 'image' && IMAGE_ID.test(background.image) ? [background.image] : []))
}

// A theme file: one theme with the appearance that goes with it, so it can be shared. The
// picture of an image background travels inside it as a data URL.
export const THEME_FILE = 'ds-bot-theme'

/**
 * @param {{ label: string, light: object, dark: object }} theme
 * @param {Record<string, unknown>} appearance - fields of the team appearance to carry along
 * @param {string} [image] - the background picture as a data URL
 */
// A theme file never carries a stylesheet: CSS from someone else could redraw the window
// to mislead or send what is typed to an address of theirs.
const NOT_CARRIED = ['mode', 'material', 'css']
export const CARRIED_FIELDS = Object.keys(FIELDS).filter(field => !NOT_CARRIED.includes(field))

// A theme travels without the colors its surfaces were last placed from: colors changed by
// hand in the file would be moved back to them by the next background or text change.
const withoutBase = theme => ({ ...theme, light: dropBase(theme.light), dark: dropBase(theme.dark) })
const dropBase = ({ base: _base, ...colors }) => colors

export function themeFile(theme, appearance = {}, image) {
  const carried = readAppearance(appearance)
  for (const field of NOT_CARRIED) delete carried[field]
  return { format: THEME_FILE, version: 1, theme: withoutBase(cleanTheme(theme)), appearance: carried, ...(image ? { image } : {}) }
}

/**
 * Read a theme file the user picked.
 * @param {string} text
 * @returns {{ theme: object, appearance: Record<string, unknown>, image?: string }} - `appearance` names every carried field, `null` for a default
 * @throws {AppearanceError} when the file is not a DS Bot theme
 */
export function readThemeFile(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { refuse('This file is not a DS Bot theme') }
  if (parsed?.format !== THEME_FILE || parsed.version !== 1) refuse('This file is not a DS Bot theme')
  const theme = withoutBase(cleanTheme(parsed.theme))
  const appearance = readAppearance(parsed.appearance)
  for (const field of NOT_CARRIED) delete appearance[field]
  const image = typeof parsed.image === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(parsed.image) ? parsed.image : undefined
  // The picture's id is set again when it is saved on this computer.
  if (appearance.background?.kind === 'image' && image === undefined) delete appearance.background
  // A field the file leaves out is its default: the look is the file's, not a mix with the
  // one in use. `appearance` is a change that names every field a file can carry.
  for (const field of CARRIED_FIELDS) appearance[field] ??= null
  return { theme, appearance, ...(image ? { image } : {}) }
}

// WCAG relative luminance and contrast, for the "hard to read" hint.
const channel = (value) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
export const luminanceOf = hex => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16))
export function contrast(a, b) {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
export const READABLE = 4.5
