// The team's appearance in the page (docs/plans/2026-11-21-appearance.md): corner size,
// density, the background behind the window, fonts and the user stylesheet. The theme
// colors stay in themes.js; this file adds what lies on top of them.
//
// The background is one fixed layer behind everything, under one wash of the theme's main
// color at the chosen opacity. While it is set the panes are clear (`--bt-skin-*`, the same
// hooks a third-party skin uses), so the picture shows through them once, not once per pane. A chat with a background of its own puts that
// one in the layer while it is open.
import { FONT_SIZE, readAppearance, SURFACE } from '../shared/appearance.js'
import { surfaceVars, veilColors, washColor } from './themes.js'

const DENSITY = {
  compact: `.bt-row{min-height:44px;padding:5px 8px}
.bt-rail .bt-row{width:48px;height:48px;min-height:48px}
.bt-set-row{min-height:40px;padding:8px 16px}
.bt-msg-line{gap:6px}`,
  roomy: `.bt-row{min-height:62px;padding:11px 10px}
.bt-rail .bt-row{width:60px;height:60px;min-height:60px}
.bt-set-row{min-height:56px;padding:16px 18px}
.bt-msg-line{gap:10px}`,
}

// The stacks the desktop app uses when no font is picked (app/src/fonts.css).
const SYSTEM_UI = '-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif'
const SYSTEM_CODE = 'ui-monospace,"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,monospace'

const scoped = (css, selector) => css.split('\n').map(rule => `${selector} ${rule}`).join('\n')

const fit = background => (background.fit === 'contain' ? 'center/contain no-repeat' : background.fit === 'tile' ? 'top left/auto repeat' : 'center/cover no-repeat')

/**
 * The layer's paint for a background.
 * @param {object} background - as readAppearance keeps it
 * @param {(id: string) => string | undefined} pictureUrl - a loaded picture's URL, or undefined while it loads
 * @returns {string | undefined} a CSS `background` value, or undefined when there is nothing to paint yet
 */
export function backgroundPaint(background, pictureUrl) {
  switch (background?.kind) {
    case 'color': return background.color
    case 'gradient': return `linear-gradient(${background.angle ?? 180}deg,${background.from},${background.to})`
    case 'image': {
      const url = pictureUrl(background.image)
      return url === undefined ? undefined : `url("${url}") ${fit(background)}`
    }
    default: return undefined
  }
}

/**
 * The stylesheet for the appearance.
 * @param {object} options
 * @param {unknown} options.appearance - the team's saved appearance
 * @param {{ light: object, dark: object }} [options.theme] - the theme in use; its surface colors let the background through
 * @param {unknown} [options.background] - the open chat's own background, over the team's
 * @param {(id: string) => string | undefined} [options.pictureUrl]
 * @param {boolean} [options.fonts] - the window owns fonts and sizes (the desktop app); in DSH they are DSH's settings
 * @param {boolean} [options.safe] - this window was opened in safe appearance: no background, no user stylesheet
 * @param {boolean} [options.user] - end with the user stylesheet; false when it gets a sheet of its own (userCss)
 * @returns {string}
 */
export function appearanceCss({ appearance, theme, background, pictureUrl = () => undefined, fonts = false, safe = false, user = true }) {
  const look = readAppearance(appearance)
  const vars = []
  const rules = []
  if (look.radius !== undefined) vars.push(`--bt-r:${look.radius / 100}`)
  if (fonts) {
    // A font the device does not have falls through to the system font.
    if (look.uiFont) rules.push(`html body{font-family:${look.uiFont},${SYSTEM_UI}}`)
    if (look.codeFont) rules.push(`html body :is(code,pre,kbd,samp){font-family:${look.codeFont},${SYSTEM_CODE}}`)
    if (look.fontSize) vars.push(`--bt-fs:${look.fontSize / FONT_SIZE.initial}`)
    if (look.lineHeight) rules.push(`html body .md_markdown{line-height:${look.lineHeight}}`)
  }
  if (look.density !== undefined) rules.push(scoped(DENSITY[look.density], 'html body'))
  const shown = safe ? undefined : (readAppearance({ background }).background ?? look.background)
  const paint = shown === undefined ? undefined : backgroundPaint(shown, pictureUrl)
  if (paint !== undefined) {
    const alpha = (shown.surface ?? SURFACE.initial) / 100
    rules.push(`html body::before{content:"";position:fixed;inset:${shown.blur ? `-${shown.blur * 2}px` : '0'};z-index:-1;pointer-events:none;background:${paint};${shown.blur ? `filter:blur(${shown.blur}px);` : ''}}`)
    if (theme !== undefined) {
      const veil = veilColors((shown.dim ?? 0) / 100)
      const over = (mode, dimmed) => `linear-gradient(${washColor(mode, alpha)},${washColor(mode, alpha)}),linear-gradient(${dimmed},${dimmed})`
      rules.push(`html body{${surfaceVars(theme.light, alpha)}}`)
      rules.push(`html body[data-ds-dark-theme]{${surfaceVars(theme.dark, alpha)}}`)
      rules.push(`html body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:${over(theme.light, veil.light)}}`)
      rules.push(`html body[data-ds-dark-theme]::after{background:${over(theme.dark, veil.dark)}}`)
    }
  }
  const head = vars.length === 0 ? '' : `html body{${vars.join(';')}}`
  const own = [head, ...rules].filter(Boolean).join('\n')
  return user ? own + userCss(appearance, safe) : own
}

/** The user's own stylesheet, kept as written; nothing in safe appearance. */
export function userCss(appearance, safe = false) {
  const css = readAppearance(appearance).css
  return safe || !css ? '' : `\n/* user stylesheet */\n${css}`
}

/** Whether a background is painted, so the surfaces should let it through. */
export const backgroundShown = ({ appearance, background, safe }) => !safe && (readAppearance({ background }).background ?? readAppearance(appearance).background) !== undefined

// Pictures, loaded once per id and kept as object URLs: the id is the hash of the bytes.
const pictures = new Map()
/**
 * @param {string} id
 * @param {(endpoint: string, payload: object) => Promise<any>} call - the plugin's `api/bot` call
 * @param {() => void} loaded - called once the picture is ready to paint
 * @returns {string | undefined} the picture's URL once loaded
 */
export function pictureUrl(id, call, loaded) {
  const known = pictures.get(id)
  if (typeof known === 'string') return known
  if (known === undefined) {
    pictures.set(id, null)
    void call('background-picture', { id }).then(async (picture) => {
      if (picture?.image === undefined) { pictures.delete(id); return }
      const blob = await (await fetch(picture.image)).blob()
      pictures.set(id, URL.createObjectURL(blob))
      loaded()
    }).catch(() => pictures.delete(id))
  }
  return undefined
}

// Safe appearance: Shift held while the window opens. It holds for this window until it
// closes, through reloads, and never changes the saved settings.
const SAFE_KEY = 'ds-bot.safe-appearance'
const SAFE_WINDOW_MS = 3000
let safe = false
try { safe = sessionStorage.getItem(SAFE_KEY) === '1' } catch { /* storage unavailable */ }
const safeListeners = new Set()
export const safeAppearance = () => safe
export const onSafeAppearance = (listener) => {
  safeListeners.add(listener)
  return () => safeListeners.delete(listener)
}
export function leaveSafeAppearance() {
  safe = false
  try { sessionStorage.removeItem(SAFE_KEY) } catch { /* storage unavailable */ }
  for (const listener of safeListeners) listener(false)
}
/**
 * Watch for Shift in the first seconds after DS Bot's interface is up. A Shift pressed
 * then, or held while the mouse moves or clicks, counts: on macOS a held modifier does not
 * repeat its key event, so a Shift held from before the page loaded is seen only on the
 * pointer's events.
 * @returns {() => void} stop watching
 */
export function watchSafeAppearance(target = globalThis.window, now = () => Date.now()) {
  if (target === undefined || safe) return () => {}
  const until = now() + SAFE_WINDOW_MS
  const onEvent = (event) => {
    if (now() > until) { stop(); return }
    const shift = event.type === 'keydown' ? event.key === 'Shift' || /^Shift(Left|Right)$/.test(event.code ?? '') : event.shiftKey === true
    if (!shift) return
    safe = true
    try { sessionStorage.setItem(SAFE_KEY, '1') } catch { /* storage unavailable */ }
    stop()
    for (const listener of safeListeners) listener(true)
  }
  const EVENTS = ['keydown', 'pointermove', 'pointerdown']
  const stop = () => { for (const type of EVENTS) target.removeEventListener(type, onEvent, true) }
  for (const type of EVENTS) target.addEventListener(type, onEvent, true)
  const timer = setTimeout(stop, SAFE_WINDOW_MS)
  return () => { clearTimeout(timer); stop() }
}

/** The change "Restore default appearance" sends: theme, accent and every appearance field back to default; user themes stay. */
export const DEFAULT_APPEARANCE_CHANGE = { theme: 'deepseek', accent: null, appearance: { radius: null, density: null, background: null, css: null, mode: null, uiFont: null, codeFont: null, fontSize: null, lineHeight: null, material: null } }
