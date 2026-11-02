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
