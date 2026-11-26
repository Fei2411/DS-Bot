// A Bot avatar wears one badge at a time, as on the desktop (mark.js BotAvatar):
// waiting for you, then working, then the Main Bot star. They sit in the same corner,
// so two would cover each other.
export type Badge = 'alert' | 'working' | 'main' | null

export function badgeOf({ waiting = false, working = false, main = false }: { waiting?: boolean; working?: boolean; main?: boolean }): Badge {
  if (waiting) return 'alert'
  if (working) return 'working'
  return main ? 'main' : null
}
