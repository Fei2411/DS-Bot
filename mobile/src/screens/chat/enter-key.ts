// How the phone's composer treats Enter. `follow` takes the computer's
// `prefs.enterToSend` (on unless it was turned off there); the other two keep the
// phone's own answer and ignore the computer.
export type EnterMode = 'follow' | 'send' | 'newline'

export const enterMode = (phonePrefs: Record<string, string> | undefined, computerPrefs: Record<string, unknown> | undefined): EnterMode => {
  const stored = phonePrefs?.enterToSend
  if (stored === 'send' || stored === 'newline') return stored
  return 'follow'
}

export const sendsOnEnter = (mode: EnterMode, computerPrefs: Record<string, unknown> | undefined): boolean => {
  if (mode === 'send') return true
  if (mode === 'newline') return false
  return computerPrefs?.enterToSend !== false
}

// A multiline TextInput asks Android for IME_FLAG_NO_ENTER_ACTION, which makes the
// IME draw the return key as a plain newline. Naming a submit behavior clears the
// flag, so the keyboard can offer its own send key and its own long-press.
export const enterKeyProps = (sends: boolean): { returnKeyType?: 'send'; submitBehavior?: 'submit' } =>
  sends ? { returnKeyType: 'send', submitBehavior: 'submit' } : {}
