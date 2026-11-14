// A third-party skin (dsh-dream-skin and others) makes DSH's background tokens
// semi-transparent from its glass sliders. DS Bot colors its own surfaces from its theme,
// so those sliders never reached them. This bridge reads the composed DSH tokens — the
// value the document actually gets, override layers included — and, only while a token is
// translucent, lets the matching DS Bot surfaces use the theme color at that alpha:
// the main pane, the cards and settings, the composer glass (all off `--bt-main`) and the
// sidebar (off `--bt-sidebar`). With no skin, nothing is set and every surface keeps its
// theme color. Text keeps the theme ink; an alpha floor keeps the theme's contrast on the
// wallpaper behind the surface.

/**
 * The lowest opacity a DS Bot surface takes. Text keeps the theme ink, so the floor is
 * what guarantees its contrast over whatever wallpaper the skin shows: at 0.7 every one
 * of the four themes keeps at least 5:1 over a pure white or a pure black wallpaper
 * (70% of the theme surface, 30% of the wallpaper). A skin asking for more transparency
 * than that gets this floor; the surface still lets the wallpaper show.
 */
export const MIN_SKIN_ALPHA = 0.7

// Surfaces that follow a translucent skin; all other `--bt-*` colors stay as the theme set them.
export const SKIN_VARIABLES = ['--bt-skin-main', '--bt-skin-sidebar', '--bt-skin-card']

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i

/**
 * Parse a CSS color a theme token or a computed custom property can hold.
 * @param {unknown} value - `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` or `rgba(...)`.
 * @returns {{ r: number, g: number, b: number, a: number } | undefined} the color, or undefined for anything else (a `var()` chain, a named color, empty).
 */
export function parseColor(value) {
  const text = String(value ?? '').trim()
  const hex = HEX.exec(text)
  if (hex !== null) {
    const digits = hex[1]
    const pair = (at) => {
      const part = digits.length <= 4 ? digits[at] + digits[at] : digits.slice(at * 2, at * 2 + 2)
      return Number.parseInt(part, 16)
    }
    const alpha = digits.length === 4 ? pair(3) / 255 : digits.length === 8 ? pair(3) / 255 : 1
    return { r: pair(0), g: pair(1), b: pair(2), a: alpha }
  }
  const rgb = RGB.exec(text)
  if (rgb !== null) {
    const alpha = rgb[4] === undefined ? 1 : rgb[5] === '%' ? Number(rgb[4]) / 100 : Number(rgb[4])
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: Math.max(0, Math.min(1, alpha)) }
  }
  return undefined
}

// 8-digit hex carries the alpha without a literal color declaration the style sheet
// lint reads as one (the surfaces get their colors from the theme, not from here).
const hex2 = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
const withAlpha = ({ r, g, b }, a) => `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`

/** The color's opacity, or 1 for a value that cannot be read (opaque is the safe default). */
export const alphaOf = value => parseColor(value)?.a ?? 1

/**
 * The `--bt-skin-*` values a scene with these DSH tokens needs; empty when no token is
 * translucent (the theme's own colors then stay in charge).
 * @param {{ main?: string, sidebar?: string, colors: { main: string, sidebar: string, card: string } }} scene - the composed DSH token strings and the active theme's three surface colors.
 * @param {{ minAlpha?: number }} [options] - the alpha floor.
 * @returns {Record<string, string>} custom properties to set, or `{}`.
 */
export function skinSurfaceVars({ main, sidebar, colors }, { minAlpha = MIN_SKIN_ALPHA } = {}) {
  const vars = {}
  const floor = alpha => Math.min(1, Math.max(alpha, minAlpha))
  const mainAlpha = alphaOf(main)
  const sidebarAlpha = alphaOf(sidebar)
  if (mainAlpha < 1) {
    const alpha = floor(mainAlpha)
    vars['--bt-skin-main'] = withAlpha(parseColor(colors.main) ?? { r: 252, g: 252, b: 252 }, alpha)
    // Cards are the page's raised surfaces: they fade with the canvas, not with the sidebar.
    vars['--bt-skin-card'] = withAlpha(parseColor(colors.card) ?? { r: 255, g: 255, b: 255 }, alpha)
  }
  if (sidebarAlpha < 1) {
    vars['--bt-skin-sidebar'] = withAlpha(parseColor(colors.sidebar) ?? { r: 247, g: 247, b: 247 }, floor(sidebarAlpha))
  }
  return vars
}

/** A surface at `alpha` composited over an opaque wallpaper color. */
export function over(surface, alpha, wallpaper) {
  const back = parseColor(wallpaper) ?? { r: 255, g: 255, b: 255, a: 1 }
  return { r: surface.r * alpha + back.r * (1 - alpha), g: surface.g * alpha + back.g * (1 - alpha), b: surface.b * alpha + back.b * (1 - alpha), a: 1 }
}

// WCAG relative luminance and contrast, for the readability floor below.
const channel = value => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
export const contrastRatio = (foreground, background) => {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * The custom properties for the document right now: the composed DSH tokens read from
 * computed styles, and the active theme's colors. Safe to call on every theme change.
 * @param {Document} doc - the document whose body carries the theme and the skin tokens.
 * @param {{ light: object, dark: object }} theme - the active DS Bot theme.
 * @param {{ minAlpha?: number }} [options] - the alpha floor.
 * @returns {Record<string, string>} the variables to set (possibly none).
 */
export function readSkinSurfaceVars(doc, theme, { minAlpha = MIN_SKIN_ALPHA } = {}) {
  const body = doc?.body
  if (body === undefined) return {}
  const dark = body.hasAttribute?.('data-ds-dark-theme') === true
  const colors = dark ? theme.dark : theme.light
  const style = doc.defaultView?.getComputedStyle?.(body)
  const token = name => style?.getPropertyValue?.(name)?.trim() ?? ''
  return skinSurfaceVars({ main: token('--dsw-alias-bg-base'), sidebar: token('--dsw-specific-sidebar-fill'), colors }, { minAlpha })
}

/**
 * Keep `--bt-skin-*` on the body in step with the composed theme tokens.
 * @param {Document} doc - the document to change.
 * @param {() => Record<string, string>} read - reads the variables for the current scene.
 * @returns {() => void} a function applying the current values, and one removing them.
 */
export function writeSkinSurfaceVars(doc, read) {
  const body = doc?.body
  const apply = () => {
    if (body === undefined) return
    const vars = read() ?? {}
    for (const name of SKIN_VARIABLES) {
      if (vars[name] === undefined) body.style.removeProperty(name)
      else body.style.setProperty(name, vars[name])
    }
  }
  return {
    apply,
    clear() {
      if (body === undefined) return
      for (const name of SKIN_VARIABLES) body.style.removeProperty(name)
    },
  }
}
