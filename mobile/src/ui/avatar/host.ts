import { AccessibilityInfo, AppState, Platform } from 'react-native'
import { Clock, type Host, type Signals } from './clock.ts'
import { shownState } from './shown.ts'

// The live marks' clock in the app: frames from React Native, idle time for building
// models, the app's state for the background, and the system's reduced-motion setting.
// It listens only while some mark is up. Touches reach it through noteInput (the app's
// root view calls it); in a browser, the mouse, keys and the wheel count too, as on the
// desktop (avatar/live.js).

// The system setting is read once at start, so the first mark knows it before it moves.
let reduce = false
let current: Signals | null = null
const readReduce = () => AccessibilityInfo.isReduceMotionEnabled()
  .then((on) => { reduce = on; current?.reduceMotion(on) })
  .catch(() => {})
void readReduce()

const BROWSER_INPUTS = ['pointerdown', 'keydown', 'wheel'] as const
const page = Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null

const host: Host = {
  now: () => performance.now(),
  frame: fn => requestAnimationFrame(() => fn()),
  cancelFrame: handle => cancelAnimationFrame(handle as number),
  after: (fn, ms) => setTimeout(fn, ms),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // React Native's idle callback is not tied to frames (on iOS it offers about 50 ms
  // whenever the JS thread is free); the clock takes no more than SLICE_MS of it.
  ...(typeof requestIdleCallback === 'function' ? {
    idle: (fn, timeout) => requestIdleCallback(fn, { timeout }),
    cancelIdle: handle => cancelIdleCallback(handle as number),
  } satisfies Pick<Host, 'idle' | 'cancelIdle'> : {}),
  listen(signals) {
    current = signals
    signals.reduceMotion(reduce)
    signals.shown(shownState(AppState.currentState))
    const app = AppState.addEventListener('change', next => signals.shown(shownState(next)))
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => { reduce = on; signals.reduceMotion(on) })
    // It may have changed while no mark was up.
    void readReduce()
    const onInput = () => signals.input()
    for (const type of BROWSER_INPUTS) page?.addEventListener(type, onInput, { passive: true, capture: true })
    return () => {
      for (const type of BROWSER_INPUTS) page?.removeEventListener(type, onInput, { capture: true })
      app.remove()
      motion.remove()
      if (current === signals) current = null
    }
  },
}

export const avatarClock = new Clock(host)

// Someone touched the app, or typed in it.
export function noteInput() { current?.input() }
