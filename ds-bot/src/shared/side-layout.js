// Where the Side App panel sits: docked beside the chat, as a drawer over it, or centered.
// The host checks every value with these rules before it saves one, and the windows resolve
// what to draw with the same rules, so a value the host would refuse never reaches the page
// (docs/plans/2026-11-25-side-app-workbench.md §3.1).

export const SIDE_LAYOUTS = ['docked', 'drawer', 'centered']
export const DEFAULT_SIDE_LAYOUT = 'docked'

export const isSideLayout = value => SIDE_LAYOUTS.includes(value)

/**
 * The layout to draw a conversation's panel in: its own choice, else the default the
 * team had when it was made, else docked. A conversation that predates the setting has
 * neither, so it stays docked whatever the team default is now.
 * @param {{sideLayout?: unknown, sideLayoutInitial?: unknown}|undefined|null} subject a Bot or a group chat
 * @returns {'docked'|'drawer'|'centered'}
 */
export function effectiveSideLayout(subject) {
  if (isSideLayout(subject?.sideLayout)) return subject.sideLayout
  if (isSideLayout(subject?.sideLayoutInitial)) return subject.sideLayoutInitial
  return DEFAULT_SIDE_LAYOUT
}

/**
 * What a new conversation records at creation: the team default, only when it is not the
 * fallback (docked is what an absent field means, so it is not stored).
 * @returns {'drawer'|'centered'|undefined}
 */
export function initialSideLayout(prefs) {
  const value = prefs?.sideLayout
  return isSideLayout(value) && value !== DEFAULT_SIDE_LAYOUT ? value : undefined
}

/**
 * A requested value for one conversation or for the team: a layout, or `null` to clear.
 * @returns {{ok: true, value: string|null}|{ok: false}}
 */
export function cleanSideLayout(value) {
  if (value === null || value === '') return { ok: true, value: null }
  return isSideLayout(value) ? { ok: true, value } : { ok: false }
}
