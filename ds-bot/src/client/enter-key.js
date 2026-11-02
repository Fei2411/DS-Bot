// Enter submits only while the preference sends on Enter; off, a plain Enter is the
// field's own newline and only the send button submits. Before the roster answers,
// the snapshot's prefs come from the window's cache, so a saved `false` already holds.
export const sendsOnEnter = prefs => prefs?.enterToSend !== false

// Plain Enter can insert a line instead of submitting. Menus, modified shortcuts,
// and IME confirmation keep the host composer's own behavior.
export function insertComposerNewline(event, inputActions) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
    || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return false
  const target = event.target
  if (typeof target?.closest !== 'function' || !target.closest('[data-composer-card] [role="textbox"]')) return false
  if (target.closest('[data-composer-composing]')) return false
  if (target.ownerDocument?.querySelector('[role="listbox"]')) return false
  if (typeof inputActions?.captureInsertion !== 'function' || typeof inputActions?.insertText !== 'function') return false
  event.preventDefault()
  event.stopImmediatePropagation()
  inputActions.insertText('\n', inputActions.captureInsertion())
  return true
}
