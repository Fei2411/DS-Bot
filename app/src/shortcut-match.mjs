import { zoomKey } from './zoom-keys.mjs'

const FUNCTION_CODE = /^F([1-9]|1[0-2])$/

function isAltGrInput(input, platform) {
  if (input.key === 'AltGraph') return true
  if (Array.isArray(input.modifiers) && input.modifiers.some(m => String(m).toLowerCase() === 'altgraph')) return true
  // On Windows/Linux, Ctrl+Alt on non-function keys is reserved for AltGr character entry
  // (matching validateBinding in shortcuts-model.js) and must never hijack webpage typing.
  return platform !== 'darwin' && Boolean(input.control) && Boolean(input.alt) && !input.meta
    && !FUNCTION_CODE.test(typeof input.code === 'string' ? input.code : '')
}

/**
 * Matches an Electron `before-input-event` input record from a focused child Bot
 * WebContentsView against the active desktop shortcut whitelist synced from the window.
 * Guards IME composition, auto-repeat, window zoom keys, and AltGr character input on Windows/Linux.
 * @returns {string | null} matched shortcut command id, or null if not matched
 */
export function matchForwardedShortcut(input, bindings, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat) return null
  if (zoomKey(input, platform)) return null
  if (isAltGrInput(input, platform)) return null
  if (!Array.isArray(bindings) || bindings.length === 0) return null
  const mac = platform === 'darwin'
  for (const entry of bindings) {
    if (!entry || entry.code !== input.code) continue
    const wantMeta = mac ? entry.mod === true : false
    const wantCtrl = mac ? entry.ctrl === true : (entry.mod === true || entry.ctrl === true)
    if (Boolean(input.meta) === wantMeta
      && Boolean(input.control) === wantCtrl
      && Boolean(input.alt) === (entry.alt === true)
      && Boolean(input.shift) === (entry.shift === true)) {
      return entry.id
    }
  }
  return null
}
