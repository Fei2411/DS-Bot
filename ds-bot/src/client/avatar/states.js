// States: what a Bot is doing picks a pose, an expression, and the clips that play.
//
//   pose     where the body and eyes rest in this state (clip channels; see clips.js)
//   face     the expression held for the state
//   enter    clips to pick one from on entering (weights)
//   loop     clips the state repeats, with a pause of `gap` seconds [min, max] between.
//            These are the state's own motion and play at every motion level.
//   compact  the loop for small marks (under 28px), where big moves read as noise
//   lively   a loop that only plays at the lively motion level
//   idle     fidgets for a resting mark; they only play at the lively level
//   blink    seconds between blinks [min, max]; false keeps the eyes as they are
//   accent   a flourish drawn around large marks while in the state
//   next / hold   the state moves on to `next` after `hold` seconds
//   settle   how fast the body eases into the pose (1 = normal; dozing is slow)
// Bags list clip names with weights; the engine draws without repeating the last one.

export const STATES = {
  idle: {
    face: 'neutral',
    pose: {},
    idle: { bag: { glance: 4, lookAround: 2, checkIn: 2, sway: 2, breathe: 2, stretch: 1, hop: 1, peek: 1, twirl: 0.5 }, gap: [3.5, 9] },
    blink: [2.4, 6.4],
  },
  thinking: {
    face: 'think',
    pose: { pitch: -7, roll: 7, gx: 0.45, gy: -0.7 },
    loop: { bag: { ponder: 3, ponderSwap: 1, hmm: 1.5 }, gap: [0.3, 1.4] },
    compact: { bag: { ponder: 1, hmm: 1 }, gap: [0.6, 2] },
    blink: [3, 7],
    accent: 'dots',
  },
  searching: {
    face: 'curious',
    pose: { pitch: 4 },
    loop: { bag: { scan: 3, peer: 1, sniff: 1 }, gap: [0.1, 0.6] },
    compact: { bag: { scan: 2, sniff: 1 }, gap: [0.3, 1] },
    blink: [2.5, 5],
  },
  working: {
    face: 'focus',
    pose: { pitch: 6, gy: 0.35 },
    loop: { bag: { type: 4, read: 2, nodWork: 1, bob: 1 }, gap: [0, 0.35] },
    compact: { bag: { type: 2, bob: 1 }, gap: [0.1, 0.6] },
    blink: [2.5, 6],
  },
  sending: {
    face: 'determined',
    pose: {},
    enter: { dash: 1 },
    loop: { bag: { dash: 1 }, gap: [0.4, 1] },
    blink: [3, 6],
  },
  relaying: {
    face: 'neutral',
    pose: {},
    loop: { bag: { relay: 1 }, gap: [0.2, 0.8] },
    blink: [3, 6],
  },
  waiting: {
    face: 'neutral',
    pose: { roll: -2 },
    loop: { bag: { patient: 3, tap: 2, sigh: 1, checkIn: 1 }, gap: [1.6, 4] },
    compact: { bag: { tap: 1, patient: 1 }, gap: [2, 5] },
    blink: [2, 5],
  },
  // Needs your answer: turns to you, eyes wide, and catches your eye.
  alert: {
    face: 'wide',
    pose: { yaw: -30, pitch: -6 },
    enter: { attention: 1 },
    lively: { bag: { nudge: 1 }, gap: [3.5, 7] },
    blink: [2, 4.5],
  },
  done: {
    face: 'happy',
    pose: {},
    enter: { celebrate: 1, nodHappy: 2, hopHappy: 2 },
    compactEnter: { nodHappy: 1, hopHappy: 1 },
    next: 'idle',
    hold: 1.6,
    blink: false,
  },
  sleeping: {
    face: 'asleep',
    pose: { pitch: 9, roll: -6, y: 1.5, sq: 0.03 },
    loop: { bag: { breathe: 1 }, gap: [0.3, 0.8] },
    blink: false,
    accent: 'z',
    settle: 0.35,
  },
}

// The mark states the client passes (mark.js) map onto these; `orbit` is a Bot
// relaying messages in a group.
export const STATE_ALIASES = { orbit: 'relaying' }
export const stateName = name => (Object.hasOwn(STATES, name) ? name : STATE_ALIASES[name] ?? 'idle')
