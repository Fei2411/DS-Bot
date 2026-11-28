// Enter submits only while the preference sends on Enter; off, a plain Enter is the
// field's own newline and only the send button submits. Before the roster answers,
// the snapshot's prefs come from the window's cache, so a saved `false` already holds.
export const sendsOnEnter = prefs => prefs?.enterToSend !== false

// While a turn is running, plain Enter defaults to queuing the message for the next turn;
// users can switch the preference to 'steer', and Cmd/Ctrl+Enter always does the opposite.
export const runningEnterMode = prefs => (prefs?.runningEnter === 'steer' ? 'steer' : 'queue')

/**
 * Resolves the send mode (`'queue' | 'steer' | null`) for an Enter keydown event.
 * - While idle: plain Enter or Cmd/Ctrl+Enter sends when `enterToSend` is on (Cmd/Ctrl+Enter when off).
 * - While running with `enterToSend` on: plain Enter uses `runningEnter`, Cmd/Ctrl+Enter does the opposite.
 * - While running with `enterToSend` off: Cmd/Ctrl+Enter uses `runningEnter` (plain Enter keeps newline).
 */
export function submitModeForKey({ running, enterToSend, runningEnter = 'queue', plainEnter, modEnter }) {
  if (!plainEnter && !modEnter) return null
  if (!running) {
    return (enterToSend ? (plainEnter || modEnter) : modEnter) ? 'queue' : null
  }
  const preferred = runningEnter === 'steer' ? 'steer' : 'queue'
  const opposite = preferred === 'steer' ? 'queue' : 'steer'
  if (enterToSend) {
    if (plainEnter) return preferred
    if (modEnter) return opposite
    return null
  }
  return modEnter ? preferred : null
}

// Safari/Chromium fire keyCode === 229 on the closing Enter of a CJK IME composition
// even when isComposing has already flipped false.
export const isImeComposing = event => Boolean(
  event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229 || event?.nativeEvent?.keyCode === 229,
)

// Plain Enter can insert a line instead of submitting. Menus, modified shortcuts,
// and IME confirmation keep the host composer's own behavior.
export function insertComposerNewline(event, inputActions) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
    || isImeComposing(event) || event.getModifierState?.('AltGraph')) return false
  const target = event.target
  if (typeof target?.closest !== 'function' || !target.closest('[data-bt-composer] [data-bt-composer-input]')) return false
  if (target.closest('[data-bt-composing]')) return false
  if (target.ownerDocument?.querySelector('[role="listbox"]')) return false
  if (typeof inputActions?.captureInsertion !== 'function' || typeof inputActions?.insertText !== 'function') return false
  event.preventDefault()
  event.stopImmediatePropagation()
  inputActions.insertText('\n', inputActions.captureInsertion())
  return true
}
