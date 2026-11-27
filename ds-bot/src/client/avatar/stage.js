// What every live mark shares, however it is drawn (a canvas in the page, SVG paths
// in the phone app): the room around it, when it nods off, the confetti's colors, and
// how a mark with nothing to turn moves.

// After this long with no input, a lively mark at rest nods off; it wakes on input.
export const DOZE_MS = 150_000
// The drawing reaches past the mark on each side, so hops and spins are not cut off.
export const MARGIN = 0.3
// Confetti colors besides the body's own.
export const CONFETTI_INKS = ['rose', 'sky', 'yellow', 'green', 'violet']
// A mark that moves as a whole turns about this point of its box.
export const FLAT_ORIGIN = '50% 92%'

// A mark with nothing to turn (an uploaded photo, a shape another plugin draws) moves
// as a whole: hops, squash, lean, and a turn that narrows it like a coin. `x` and `y`
// are in percent of the mark's size, `roll` in degrees, about FLAT_ORIGIN.
export function flatPose(frame) {
  const sy = 1 - Math.max(-0.4, Math.min(0.4, frame.sq))
  const s = 1 + frame.scale
  const turn = Math.max(0.15, Math.abs(Math.cos((frame.yaw * Math.PI) / 180)))
  return { x: frame.x, y: frame.y, roll: frame.roll * 0.6, sx: s * turn / sy, sy: s * sy }
}
