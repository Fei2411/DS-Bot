// States: what a Bot is doing picks a pose, an expression, and the clips that play.
//
//   pose     where the body and eyes rest in this state (clip channels; see clips.js)
//   face     the expression held for the state
//   enter    clips to pick one from on entering (weights)
//   loop     clips the state repeats, with a pause of `gap` seconds [min, max] between.
//            These are the state's own motion: they play at every motion level, and on,
//            more sparsely, while the window rests. Each state's loop has a shape of its
//            own (a slow tilt, quick side looks, a fast beat, hops), so what a Bot is
//            doing reads from its motion alone, down to an 18px mark.
//   compact  the loop for small marks (under 28px): the moves that read at that size
//   lively   a loop that only plays at the lively motion level
//   idle     fidgets for a resting mark; they only play at the lively level
//   blink    seconds between blinks [min, max]; false keeps the eyes as they are
//   accent   a flourish drawn around large marks while in the state
//   A pose turns the body (yaw) by TURN degrees at most (clips.js).
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
    pose: { pitch: -7, roll: 7, gx: 0.3, gy: -0.65 },
    loop: { bag: { ponder: 2, ponderSwap: 1.5, hmm: 0.5 }, gap: [0.2, 0.9] },
    compact: { bag: { ponder: 1, ponderSwap: 1 }, gap: [0.2, 0.9] },
    blink: [3, 7],
    accent: 'dots',
  },
  searching: {
    face: 'curious',
    pose: { pitch: 4 },
    loop: { bag: { scan: 3, peer: 1, sniff: 1 }, gap: [0.1, 0.6] },
    compact: { bag: { scan: 1 }, gap: [0.2, 0.8] },
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
  // Waiting for work it handed on: taps its foot, and looks over to where the work went.
  waiting: {
    face: 'neutral',
    pose: { roll: -2 },
    loop: { bag: { tap: 2, patient: 2, sigh: 1 }, gap: [1, 2.6] },
    compact: { bag: { tap: 1, patient: 1 }, gap: [1, 2.6] },
    blink: [2, 5],
  },
  // Background tasks run while its chat is idle: working's nod at half the pace.
  background: {
    face: 'neutral',
    pose: { pitch: 3, gy: 0.3 },
    loop: { bag: { hum: 1 }, gap: [0.9, 1.8] },
    blink: [2.5, 6],
  },
  // Needs your answer: sits up, eyes wide and on you, and hops to catch your eye every
  // few seconds until you answer, at every motion level.
  alert: {
    face: 'wide',
    pose: { pitch: -5, y: -1, scale: 0.03 },
    enter: { attention: 1 },
    loop: { bag: { call: 1 }, gap: [2.4, 4.2] },
    blink: [2, 4.5],
  },
  // The last turn failed: slumped and worried, it shakes its head now and then until a
  // turn goes through.
  failed: {
    face: 'worried',
    pose: { pitch: 8, y: 2.5, roll: -6, sq: 0.04 },
    enter: { slump: 1 },
    loop: { bag: { shake: 2, slump: 1 }, gap: [2.6, 4.6] },
    compact: { bag: { shake: 1 }, gap: [2.6, 4.6] },
    blink: [3, 7],
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
  // Finished with a reply you have not read: a soft smile, nothing more (the row's
  // unread dot says the rest).
  replied: {
    face: 'content',
    pose: {},
    blink: [3, 7],
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
