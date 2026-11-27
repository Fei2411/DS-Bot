// The team's appearance in the page (docs/plans/2026-11-21-appearance.md): corner size,
// density, the background behind the window, fonts and the user stylesheet. The theme
// colors stay in themes.js; this file adds what lies on top of them.
//
// The background is one fixed layer behind everything, under one wash of the theme's main
// color at the chosen opacity. While it is set the panes are clear (`--bt-skin-*`, the same
// hooks a third-party skin uses), so the picture shows through them once, not once per pane. A chat with a background of its own puts that
// one in the layer while it is open.
import { FONT_SIZE, fontStack, readAppearance, SURFACE } from '../shared/appearance.js'
import { surfaceVars, veilColors, washColor } from './themes.js'
import { mountUserStylesheet } from './theme-css.js'

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
 * @param {boolean} [options.fonts] - the window owns font size and line height (the desktop app); in DSH they are DSH's settings
 * @param {boolean} [options.safe] - this window was opened in safe appearance: no background, no user stylesheet
 * @param {boolean} [options.user] - sync the user stylesheet too; it never joins this text (userCss)
 * @returns {string}
 */
export function appearanceCss({ appearance, theme, background, pictureUrl = () => undefined, fonts = false, safe = false, user = true }) {
  const look = readAppearance(appearance)
  const vars = []
  const rules = []
  if (look.radius !== undefined) vars.push(`--bt-r:${look.radius / 100}`)
  // Fonts in both forms. DSH's own font variables (`--dsh-font-family-text`, `-code`, ahead
  // of its built-in stacks) carry them into what DSH draws; DS Bot's own (`--bt-font`,
  // `--bt-mono`) into what DS Bot draws, also where no DSH stylesheet sets DSH's (the desktop
  // app's own window). A font the device does not have falls through to the system font.
  if (look.uiFont) {
    vars.push(`--dsh-font-family-text:${fontStack(look.uiFont)}`, `--bt-font:${fontStack(look.uiFont)},${SYSTEM_UI}`)
    rules.push(`html body{font-family:${fontStack(look.uiFont)},${SYSTEM_UI}}`)
  }
  if (look.codeFont) {
    vars.push(`--dsh-font-family-code:${fontStack(look.codeFont)}`, `--bt-mono:${fontStack(look.codeFont)},${SYSTEM_CODE}`)
    rules.push(`html body :is(code,pre,kbd,samp){font-family:${fontStack(look.codeFont)},${SYSTEM_CODE}}`)
  }
  if (fonts) {
    if (look.fontSize) vars.push(`--bt-fs:${look.fontSize / FONT_SIZE.initial}`, `--dsh-content-font-size:${look.fontSize}px`)
    if (look.lineHeight) rules.push(`html body .md_markdown{line-height:${look.lineHeight}}`)
  }
  if (look.density !== undefined) rules.push(scoped(DENSITY[look.density], 'html body'))
  const { shown, paint } = painted({ appearance, background, pictureUrl, safe })
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

// The user's own stylesheet is never injected as text. Written CSS could redraw the
// window to mislead or send what is typed elsewhere, so it reaches the page only through
// the sanitized constructed stylesheet (theme-css.js); every render syncs it here, as
// both callers (the plugin and the desktop app) call this on each redraw. The text is
// always empty: nothing user-written is ever re-serialized into a <style> element, and
// without constructed stylesheets the user stylesheet simply does not apply.
export function userCss(appearance, safe = false, doc = globalThis.document) {
  const css = readAppearance(appearance).css
  mountUserStylesheet(doc, safe ? '' : (css ?? ''))
  return ''
}

// The background in effect and its paint. A picture still loading, missing or broken has no
// paint, and then nothing lets the page through: the panes keep their solid colors.
function painted({ appearance, background, pictureUrl = () => undefined, safe = false }) {
  const shown = safe ? undefined : (readAppearance({ background }).background ?? readAppearance(appearance).background)
  return { shown, paint: shown === undefined ? undefined : backgroundPaint(shown, pictureUrl) }
}

/** Whether a background is painted now, so the panes should let it through. */
export const backgroundShown = options => painted(options).paint !== undefined

// Pictures, loaded once per id and kept as object URLs: the id is the hash of the bytes. A
// picture that could not be read is asked for again only after a while, not on every redraw.
const pictures = new Map()
const RETRY_MS = 60_000
/**
 * @param {string} id
 * @param {(endpoint: string, payload: object) => Promise<any>} call - the plugin's `api/bot` call
 * @param {() => void} loaded - called once the picture is ready to paint
 * @returns {string | undefined} the picture's URL once loaded
 */
export function pictureUrl(id, call, loaded) {
  const known = pictures.get(id)
  if (typeof known === 'string') return known
  if (known === undefined || (typeof known === 'number' && Date.now() - known > RETRY_MS)) {
    pictures.set(id, null)
    const failed = () => pictures.set(id, Date.now())
    void call('background-picture', { id }).then(async (picture) => {
      if (picture?.image === undefined) { failed(); return }
      const blob = await (await fetch(picture.image)).blob()
      pictures.set(id, URL.createObjectURL(blob))
      loaded()
    }).catch(failed)
  }
  return undefined
}

// Safe appearance: Shift held while the window opens. It holds for this window until it
// closes, through reloads, and never changes the saved settings.
const SAFE_KEY = 'ds-bot.safe-appearance'
const SAFE_WINDOW_MS = 3000
const SAFE_HOLD_MS = 600
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
 * Watch for Shift held on its own, pressed in the first seconds after DS Bot's interface is
 * up. Typing (Shift with a letter), a shortcut with another modifier, or a quick tap does
 * not count: Shift has to stay down for a moment with no other key. On macOS a held
 * modifier does not repeat its key event, so a Shift held from before the page loaded is
 * seen on the pointer's events instead.
 * @returns {() => void} stop watching
 */
export function watchSafeAppearance(target = globalThis.window, now = () => Date.now(), wait = setTimeout, unwait = clearTimeout) {
  if (target === undefined || safe) return () => {}
  const until = now() + SAFE_WINDOW_MS
  let hold = 0
  const isShift = event => event.key === 'Shift' || /^Shift(Left|Right)$/.test(event.code ?? '')
  const otherModifier = event => event.metaKey === true || event.ctrlKey === true || event.altKey === true
  const turnOn = () => {
    safe = true
    try { sessionStorage.setItem(SAFE_KEY, '1') } catch { /* storage unavailable */ }
    stop()
    for (const listener of safeListeners) listener(true)
  }
  const onEvent = (event) => {
    if (event.type === 'keyup') { if (isShift(event)) { unwait(hold); hold = 0 } return }
    if (event.type === 'keydown') {
      unwait(hold)
      hold = 0
      if (!isShift(event) || otherModifier(event) || now() > until) return
      hold = wait(turnOn, SAFE_HOLD_MS)
      return
    }
    // Shift held from before the window opened has no key press: the first move or click
    // tells, and only that one, so Shift pressed later to type while the mouse moves does not.
    if (pointerSeen) return
    pointerSeen = true
    if (now() <= until && event.shiftKey === true && !otherModifier(event)) turnOn()
  }
  let pointerSeen = false
  const EVENTS = ['keydown', 'keyup', 'pointermove', 'pointerdown']
  const stop = () => { for (const type of EVENTS) target.removeEventListener(type, onEvent, true) }
  for (const type of EVENTS) target.addEventListener(type, onEvent, true)
  // A hold that started in time may finish after the window closed.
  const timer = wait(() => { if (hold === 0) stop() }, SAFE_WINDOW_MS + SAFE_HOLD_MS)
  return () => { unwait(timer); unwait(hold); stop() }
}

/**
 * Briefly enables smooth color-morph transitions on accent/theme surfaces when the user
 * switches theme, accent, or color mode. Honors `effects === 'off'` and reduced motion.
 */
let morphTimer = 0
export function triggerColorMorph(durationMs = 280, targetDocument = globalThis.document, targetWindow = globalThis.window) {
  const body = targetDocument?.body
  if (!body || typeof body.setAttribute !== 'function') return false
  if (body.dataset?.btEffects === 'off') return false
  if (targetWindow?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false
  body.setAttribute('data-bt-color-morph', '')
  clearTimeout(morphTimer)
  morphTimer = setTimeout(() => {
    body.removeAttribute?.('data-bt-color-morph')
    morphTimer = 0
  }, durationMs)
  return true
}

/** The change "Restore default appearance" sends: theme, accent and every appearance field back to default; user themes stay. */
export const DEFAULT_APPEARANCE_CHANGE = { theme: 'deepseek', accent: null, appearance: { radius: null, density: null, background: null, css: null, mode: null, uiFont: null, codeFont: null, fontSize: null, lineHeight: null, material: null } }
