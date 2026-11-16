// The drawer's width and its position as a number between 0 (closed) and 1
// (open). The pixel offset is derived from the live width every frame, so a
// window resize (rotation, split screen, a cold start before the window is
// measured) cannot leave a strip of the panel on screen. The functions that the
// animations call run on the UI thread, hence the worklet directives.
//
// The panel is anchored with `left: 0`, which React Native places on the leading
// edge: the left of a left-to-right app, the right of a right-to-left one (an
// Arabic tablet). The offset and the drag therefore mirror with `rtl`; a fixed
// negative offset left the panel sitting in the middle of an RTL screen.
export const DRAWER_MAX_WIDTH = 340
const MIN_WIDTH = 1
const FLICK = 350

export function drawerWidth(windowWidth: number): number {
  'worklet'
  const width = Math.min(windowWidth * 0.85, DRAWER_MAX_WIDTH)
  return Number.isFinite(width) && width > MIN_WIDTH ? width : MIN_WIDTH
}

export function clampProgress(progress: number): number {
  'worklet'
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
}

// Off screen means past the leading edge: left for LTR, right for RTL.
export function panelOffset(progress: number, width: number, rtl: boolean): number {
  'worklet'
  const open = clampProgress(progress)
  return rtl ? (1 - open) * width : (open - 1) * width
}

// A drag adds to the progress it started from. It opens when it pulls the panel
// into the screen: rightwards in LTR, leftwards in RTL.
export function progressAfterDrag(startProgress: number, translationX: number, width: number, rtl: boolean): number {
  'worklet'
  return clampProgress(startProgress + (rtl ? -translationX : translationX) / Math.max(MIN_WIDTH, width))
}

// A flick wins over the distance; otherwise the drawer settles to the nearer end.
export function settleProgress(progress: number, velocityX: number, rtl: boolean): number {
  'worklet'
  if (rtl ? velocityX < -FLICK : velocityX > FLICK) return 1
  if (rtl ? velocityX > FLICK : velocityX < -FLICK) return 0
  return clampProgress(progress) >= 0.5 ? 1 : 0
}

// Back closes the drawer only while it is actually on screen.
export function shouldConsumeBack(progress: number): boolean {
  'worklet'
  return clampProgress(progress) > 0
}

// The edge strip starts below the chat header so the header's menu button keeps
// its whole touch target.
export function edgeTop(topInset: number): number {
  'worklet'
  return topInset + 56
}
