// The interface motion level (Settings → Appearance), with the system's reduced-motion
// request: `off` holds everything still, `reduced` keeps only short one-shot moves. No
// React here, so the avatar's live layer (avatar/live.js) shares it.
export const effectsTier = () => {
  const tier = typeof document === 'undefined' ? undefined : (document.body?.dataset?.btEffects || document.documentElement?.dataset?.btEffects)
  return tier === 'reduced' || tier === 'off' ? tier : 'full'
}
export const systemReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
export const reducedMotion = () => effectsTier() === 'off' || systemReducedMotion()
export const reducedEffects = () => effectsTier() !== 'full' || systemReducedMotion()
