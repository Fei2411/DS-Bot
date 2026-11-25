const BASE_SYMBOL_BY_CODE = {
  Digit0: ['0', ')'],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Period: ['.', '>'],
  Comma: [',', '<'],
  Slash: ['/', '?'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  Backquote: ['`', '~'],
}

function isLikelyAltGrInput(input, platform) {
  if (input.key === 'AltGraph') return true
  if (Array.isArray(input.modifiers) && input.modifiers.some(m => String(m).toLowerCase() === 'altgraph')) return true
  if (platform === 'darwin' || !input.control || !input.alt || input.meta) return false
  // Windows/Linux AltGr dead keys (distinct from macOS Option+<key> dead keys, which stay assignable).
  if (input.key === 'Dead') return true
  if (typeof input.key !== 'string' || input.key.length !== 1) return false
  const code = typeof input.code === 'string' ? input.code : ''
  // When Electron omits the AltGraph modifier bit on Windows/Linux, genuine AltGr
  // character input transforms letters/digits/punctuation into third-level symbols
  // (e.g. KeyQ -> '@', KeyL -> 'ł', Digit7 -> '{', unshifted Period -> '>'), while
  // ordinary Ctrl+Alt shortcuts preserve ASCII letters (across QWERTY/QWERTZ/AZERTY)
  // or the physical key's base symbol matching the reported Shift state.
  if (/^Key[A-Z]$/.test(code)) return !/^[a-z]$/i.test(input.key)
  const expected = BASE_SYMBOL_BY_CODE[code]
  if (expected) return input.key !== (input.shift ? expected[1] : expected[0])
  return false
}

/**
 * Matches an Electron `before-input-event` input record from a focused child Bot
 * WebContentsView against the active desktop shortcut whitelist synced from the window.
 * Guards IME composition, auto-repeat, and AltGr (AltGraph) character input on Windows/Linux.
 * @returns {string | null} matched shortcut command id, or null if not matched
 */
export function matchForwardedShortcut(input, bindings, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat) return null
  if (isLikelyAltGrInput(input, platform)) return null
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
