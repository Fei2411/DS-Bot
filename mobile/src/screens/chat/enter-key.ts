// How the mobile composer treats Enter. Native iOS/Android default to `newline`
// so touch keyboards keep their newline key until the user opts in; the web build
// defaults to `follow`, which takes the computer's `prefs.enterToSend` (on unless
// turned off there). `send` and `newline` keep the device's own answer and ignore
// the computer.
export type EnterMode = 'follow' | 'send' | 'newline'

export const enterMode = (phonePrefs: Record<string, string> | undefined, platform?: string): EnterMode => {
  const stored = phonePrefs?.enterToSend
  if (stored === 'follow' || stored === 'send' || stored === 'newline') return stored
  return platform === 'web' ? 'follow' : 'newline'
}

export const sendsOnEnter = (mode: EnterMode, computerPrefs: Record<string, unknown> | undefined): boolean => {
  if (mode === 'send') return true
  if (mode === 'newline') return false
  return computerPrefs?.enterToSend !== false
}
