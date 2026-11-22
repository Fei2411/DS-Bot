// How the phone's composer treats Enter. `follow` takes the computer's
// `prefs.enterToSend` (on unless it was turned off there); the other two keep the
// phone's own answer and ignore the computer.
export type EnterMode = 'follow' | 'send' | 'newline'

export const enterMode = (phonePrefs: Record<string, string> | undefined): EnterMode => {
  const stored = phonePrefs?.enterToSend
  if (stored === 'send' || stored === 'newline') return stored
  return 'follow'
}

export const sendsOnEnter = (mode: EnterMode, computerPrefs: Record<string, unknown> | undefined): boolean => {
  if (mode === 'send') return true
  if (mode === 'newline') return false
  return computerPrefs?.enterToSend !== false
}
