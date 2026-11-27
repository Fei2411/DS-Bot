// Where keyboard focus goes when the Side App panel closes. The panel never traps focus:
// the chat box keeps it while the panel opens, and Escape or the close button hands it back
// only if it was in the panel. The decision is pure so a test can drive it with plain objects.

// The control that opened the panel when it can be found again, else the conversation's own
// entry point in the header, else nothing (the browser keeps focus where it falls).
export const PANEL_OPENER = '[data-panel-opener]'
export const HEADER_ENTRY = '.bt-pill'

/**
 * @param {{panel: object|null, active: object|null, opener: object|null, find: (selector: string) => object|null}} input
 *   `active` is what has focus as the panel closes, `opener` what had it when the panel opened.
 * @returns {object|null} the element to focus, or null to leave focus alone
 */
export function focusTargetOnClose({ panel, active, opener, find }) {
  if (panel === null || active === null || active === undefined) return null
  // Focus in the chat box, the sidebar or anywhere outside the panel stays where it is.
  if (!panel.contains(active)) return null
  if (opener && opener.isConnected !== false && !panel.contains(opener)) return opener
  return find(PANEL_OPENER) ?? find(HEADER_ENTRY) ?? null
}

/** Remember who has focus now, unless it is already inside the panel. */
export function openerBeforeOpen({ panel, active }) {
  if (active === null || active === undefined) return null
  if (panel?.contains?.(active)) return null
  return active
}
