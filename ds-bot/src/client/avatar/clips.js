// Clips: short, reusable moves. A clip is a set of tracks, one per channel, each a list
// of keys [time (s), value, ease into this key]. Values add on top of the state's pose
// and every track starts and ends at 0, so a clip can start or stop at any moment
// without a jump. Each clip is made fresh when it plays, from a random source, so the
// same move comes out a little different every time and some moves pick a side.
//
// Channels, in the mark's 100-unit box (y down):
//   x, y       move              yaw, pitch, roll  turn (degrees; yaw > 0 turns away
//   sq         squash (> 0) or stretch (< 0) on the feet   from you, pitch > 0 nods)
//   scale      grow from the middle        gx, gy  eyes across the face (-1 to 1)
//   lid        close both eyes (0–1)       pupil   eye size (0 = as drawn)
// Events: `face` [[time, name or null]] holds an expression (null hands it back to the
// state); `blink` [time, ...] blinks; `commit` clips finish even when the state moves
// on (a spin can't stop halfway); `accent` names a flourish drawn around the body.
//
// The characters are drawn as flat art, seen from one side. Turned more than a few
// degrees, one shows its flat side and both eyes slide to one edge, so a clip looks
// with the eyes and leans or shifts the body; only a spin turns all the way round.
// TURN is the most a clip or a pose turns the body (yaw) without spinning.
export const TURN = 5

// Cubic-bezier eases, by name.
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sampleX = t => ((ax * t + bx) * t + cx) * t
  const sampleY = t => ((ay * t + by) * t + cy) * t
  const slopeX = t => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    let t = x
    for (let i = 0; i < 6; i += 1) {
      const dx = sampleX(t) - x
      const slope = slopeX(t)
      if (Math.abs(dx) < 1e-5 || Math.abs(slope) < 1e-6) break
      t -= dx / slope
    }
    return sampleY(Math.max(0, Math.min(1, t)))
  }
}
export const EASES = {
  linear: t => t,
  in: bezier(0.5, 0, 0.9, 0.5),
  out: bezier(0.15, 0.6, 0.4, 1),
  inOut: bezier(0.45, 0, 0.25, 1),
  // Fast start that lands soft: eyes snapping to a new spot.
  snap: bezier(0.1, 0.8, 0.2, 1),
  // Overshoots and settles back.
  back: bezier(0.3, 1.5, 0.55, 1),
}

// The value of a track at time t.
export function sampleTrack(keys, t) {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i += 1) {
    const [t1, v1, ease] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      const span = t1 - t0
      const k = span <= 0 ? 1 : (EASES[ease] ?? EASES.inOut)((t - t0) / span)
      return v0 + (v1 - v0) * k
    }
  }
  return keys[keys.length - 1][1]
}

export const CHANNELS = ['x', 'y', 'yaw', 'pitch', 'roll', 'sq', 'scale', 'gx', 'gy', 'lid', 'pupil']
// Channels that flip with the side a clip picks.
const MIRRORED = new Set(['x', 'yaw', 'roll', 'gx'])

// Builds a clip from tracks given at a duration of 1 (times 0–1) or in seconds.
function clip(dur, tracks, extra = {}) {
  return { dur, tracks, ...extra }
}
const jitter = (rng, value, spread = 0.15) => value * (1 + (rng() * 2 - 1) * spread)
const side = rng => (rng() < 0.5 ? -1 : 1)
const mirror = (made, s) => {
  if (s === 1) return made
  const tracks = {}
  for (const [name, keys] of Object.entries(made.tracks)) tracks[name] = MIRRORED.has(name) ? keys.map(([t, v, e]) => [t, -v, e]) : keys
  return { ...made, tracks }
}
// A track scaled in time, for clips whose holds vary.
const at = (keys, k) => keys.map(([t, v, e]) => [t * k, v, e])

// A hop: crouch, spring up stretched, land squashed, settle. It lasts 0.84 s at
// `pace` 1; a smaller pace hops quicker.
const HOP = 0.84
function hopTracks(h, pace = 1) {
  return {
    y: at([[0, 0], [0.1, 0.8, 'out'], [0.3, -h, 'out'], [0.36, -h, 'linear'], [0.54, 0, 'in'], [0.84, 0, 'linear']], pace),
    sq: at([[0, 0], [0.1, 0.09, 'out'], [0.2, -0.09, 'out'], [0.36, 0, 'inOut'], [0.54, 0, 'linear'], [0.6, 0.12, 'out'], [0.72, -0.035, 'inOut'], [0.84, 0, 'inOut']], pace),
    pitch: at([[0, 0], [0.1, 3], [0.3, -4], [0.56, 2.5], [0.76, 0]], pace),
  }
}

export const CLIPS = {
  // ---- Idle: small signs of life between states.
  glance(rng) {
    const s = side(rng)
    const hold = 0.7 + rng() * 0.9
    const gx = 0.55 + rng() * 0.3
    const gy = rng() * 0.6 - 0.32
    return mirror(clip(hold + 0.62, {
      gx: [[0, 0], [0.1, gx, 'snap'], [0.1 + hold, gx, 'linear'], [0.28 + hold, 0, 'inOut']],
      gy: [[0, 0], [0.1, gy, 'snap'], [0.1 + hold, gy, 'linear'], [0.28 + hold, 0, 'inOut']],
      yaw: [[0, 0], [0.12, 0, 'linear'], [0.5, 2.5, 'inOut'], [0.1 + hold, 2.5, 'linear'], [0.62 + hold, 0, 'inOut']],
      roll: [[0, 0], [0.12, 0, 'linear'], [0.5, -1.5, 'inOut'], [0.1 + hold, -1.5, 'linear'], [0.62 + hold, 0, 'inOut']],
    }), s)
  },
  lookAround(rng) {
    const k = jitter(rng, 1, 0.12)
    return mirror(clip(2.3 * k, {
      gx: at([[0, 0], [0.1, 0.8, 'snap'], [0.9, 0.8, 'linear'], [1.05, -0.7, 'snap'], [1.8, -0.7, 'linear'], [2.05, 0, 'inOut'], [2.3, 0]], k),
      yaw: at([[0, 0], [0.5, 4, 'inOut'], [0.95, 4, 'linear'], [1.55, -3.5, 'inOut'], [1.85, -3.5, 'linear'], [2.3, 0, 'inOut']], k),
      x: at([[0, 0], [0.5, 1.4, 'inOut'], [0.95, 1.4, 'linear'], [1.55, -1.2, 'inOut'], [1.85, -1.2, 'linear'], [2.3, 0, 'inOut']], k),
      roll: at([[0, 0], [0.5, -2.5, 'inOut'], [0.95, -2.5, 'linear'], [1.55, 2, 'inOut'], [1.85, 2, 'linear'], [2.3, 0, 'inOut']], k),
      pitch: at([[0, 0], [0.5, -2], [1.55, -1], [2.3, 0]], k),
    }, { blink: [0.98 * k] }), side(rng))
  },
  // Looks up at you for a moment, as if checking in: a glance away, then straight
  // out of the screen, a little taller.
  checkIn(rng) {
    const hold = 0.9 + rng() * 0.8
    return clip(hold + 1, {
      gx: [[0, 0], [0.12, -0.5, 'snap'], [0.45, 0, 'inOut'], [hold + 1, 0]],
      gy: [[0, 0], [0.45, -0.12, 'inOut'], [0.5 + hold, -0.12, 'linear'], [hold + 1, 0, 'inOut']],
      y: [[0, 0], [0.5, -1.6, 'back'], [0.5 + hold, -1.6, 'linear'], [hold + 1, 0, 'inOut']],
      scale: [[0, 0], [0.5, 0.03, 'back'], [0.5 + hold, 0.03, 'linear'], [hold + 1, 0, 'inOut']],
      pitch: [[0, 0], [0.5, -5, 'inOut'], [0.5 + hold, -5, 'linear'], [hold + 1, 0, 'inOut']],
    }, { blink: [0.22], face: [[0.55, 'content'], [hold + 0.45, null]] })
  },
  stretch() {
    return clip(1.4, {
      sq: [[0, 0], [0.18, 0.07, 'out'], [0.55, -0.12, 'out'], [0.95, -0.12, 'linear'], [1.15, 0.05, 'inOut'], [1.4, 0, 'inOut']],
      pitch: [[0, 0], [0.55, -10], [0.95, -10, 'linear'], [1.25, 0]],
      y: [[0, 0], [0.18, 0.8, 'out'], [0.55, -1], [1.2, 0]],
      lid: [[0, 0], [0.5, 0.75], [0.95, 0.75, 'linear'], [1.15, 0]],
    })
  },
  hop(rng) {
    return clip(0.84, hopTracks(jitter(rng, 11)), { face: [[0.12, 'wide'], [0.7, null]] })
  },
  sway(rng) {
    return mirror(clip(1.8, {
      roll: [[0, 0], [0.4, 6], [0.95, -4], [1.4, 1.5], [1.8, 0]],
      x: [[0, 0], [0.4, 1.5], [0.95, -1], [1.8, 0]],
      gx: [[0, 0], [0.4, -0.2], [0.95, 0.2], [1.8, 0]],
    }), side(rng))
  },
  breathe() {
    return clip(2.6, {
      scale: [[0, 0], [1.2, 0.022], [2.6, 0]],
      y: [[0, 0], [1.2, -0.4], [2.6, 0]],
    })
  },
  // A happy little turn all the way around.
  twirl() {
    return clip(1.05, {
      ...hopTracks(9),
      yaw: [[0, 0], [0.12, -10, 'out'], [0.78, 360, 'inOut'], [1.05, 360, 'linear']],
    }, { commit: true, face: [[0.16, 'happy'], [0.95, null]] })
  },
  peek(rng) {
    return mirror(clip(1.9, {
      x: [[0, 0], [0.4, 4], [1.4, 4, 'linear'], [1.9, 0]],
      roll: [[0, 0], [0.4, -5], [1.4, -5, 'linear'], [1.9, 0]],
      gx: [[0, 0], [0.15, 0.85, 'snap'], [1.4, 0.85, 'linear'], [1.7, 0]],
      pitch: [[0, 0], [0.4, 3], [1.4, 3, 'linear'], [1.9, 0]],
    }), side(rng))
  },

  // ---- Thinking: the head tips slowly to one side and stays there a while, then to the
  // other. The slow tilt is what reads as thinking, down to the smallest mark.
  ponder(rng) {
    const hold = 0.7 + rng() * 0.8
    return mirror(clip(1.4 + hold, {
      roll: [[0, 0], [0.7, 12], [0.7 + hold, 12, 'linear'], [1.4 + hold, 0]],
      x: [[0, 0], [0.7, 3.5], [0.7 + hold, 3.5, 'linear'], [1.4 + hold, 0]],
      pitch: [[0, 0], [0.7, -2], [0.7 + hold, -2, 'linear'], [1.4 + hold, 0]],
      gx: [[0, 0], [0.5, 0.3], [0.7 + hold, 0.3, 'linear'], [1.3 + hold, 0]],
    }), side(rng))
  },
  // Tips the head the other way and looks up to the other side.
  ponderSwap() {
    return clip(2.4, {
      roll: [[0, 0], [0.6, -17], [1.8, -17, 'linear'], [2.4, 0]],
      x: [[0, 0], [0.6, -4], [1.8, -4, 'linear'], [2.4, 0]],
      gx: [[0, 0], [0.16, -0.95, 'snap'], [1.8, -0.95, 'linear'], [2.15, 0]],
      yaw: [[0, 0], [0.6, -3], [1.8, -3, 'linear'], [2.4, 0]],
    }, { blink: [0.3] })
  },
  hmm() {
    return clip(0.7, {
      pitch: [[0, 0], [0.14, 5, 'out'], [0.32, 0], [0.46, 4, 'out'], [0.66, 0]],
      y: [[0, 0], [0.14, 0.6], [0.32, 0], [0.46, 0.5], [0.66, 0]],
    })
  },

  // ---- Searching: quick looks one way, the other, and back, the body following the
  // eyes. Quick and side to side, unlike thinking's slow tilt.
  scan(rng) {
    return mirror(clip(1.5, {
      gx: [[0, 0], [0.08, 0.95, 'snap'], [0.5, 0.95, 'linear'], [0.58, -0.95, 'snap'], [1, -0.95, 'linear'], [1.08, 0.6, 'snap'], [1.3, 0.6, 'linear'], [1.5, 0]],
      x: [[0, 0], [0.25, 4.5], [0.5, 4.5, 'linear'], [0.75, -4.5], [1, -4.5, 'linear'], [1.25, 2], [1.5, 0]],
      roll: [[0, 0], [0.25, 4], [0.75, -4], [1.25, 2], [1.5, 0]],
      yaw: [[0, 0], [0.25, 3], [0.75, -3], [1.25, 1.5], [1.5, 0]],
      pitch: [[0, 0], [0.3, 2], [1.2, 2, 'linear'], [1.5, 0]],
    }, { blink: [0.55] }), side(rng))
  },
  peer() {
    return clip(1.3, {
      pitch: [[0, 0], [0.3, 8, 'out'], [0.9, 8, 'linear'], [1.3, 0]],
      scale: [[0, 0], [0.3, 0.045, 'out'], [0.9, 0.045, 'linear'], [1.3, 0]],
      lid: [[0, 0], [0.3, 0.35], [0.9, 0.35, 'linear'], [1.2, 0]],
      y: [[0, 0], [0.3, 1], [1.3, 0]],
    })
  },
  sniff() {
    return clip(0.62, {
      y: [[0, 0], [0.1, 1.2, 'out'], [0.22, 0], [0.34, 1.2, 'out'], [0.48, 0], [0.62, 0]],
      pitch: [[0, 0], [0.1, 4, 'out'], [0.22, 0], [0.34, 4, 'out'], [0.48, 0], [0.62, 0]],
    })
  },

  // ---- Working: a quick, steady beat with the head down, as if typing. The fastest
  // regular rhythm of any state.
  type(rng) {
    const s = side(rng)
    return clip(0.82, {
      pitch: [[0, 0], [0.09, 4, 'out'], [0.2, 0], [0.29, 3.5, 'out'], [0.4, 0], [0.49, 4, 'out'], [0.6, 0], [0.69, 3, 'out'], [0.82, 0]],
      y: [[0, 0], [0.09, 1.8, 'out'], [0.2, 0], [0.29, 1.6, 'out'], [0.4, 0], [0.49, 1.8, 'out'], [0.6, 0], [0.69, 1.3, 'out'], [0.82, 0]],
      sq: [[0, 0], [0.09, 0.02], [0.2, 0], [0.49, 0.02], [0.6, 0], [0.82, 0]],
      gx: [[0, 0], [0.12, -0.3 * s], [0.7, 0.3 * s, 'linear'], [0.82, 0]],
    })
  },
  nodWork() {
    return clip(0.6, {
      pitch: [[0, 0], [0.22, 8, 'out'], [0.42, -2], [0.6, 0]],
      y: [[0, 0], [0.22, 1.2, 'out'], [0.6, 0]],
    })
  },
  read(rng) {
    return mirror(clip(1.8, {
      gx: [[0, 0], [0.12, -0.5, 'snap'], [1.5, 0.5, 'linear'], [1.8, 0]],
      roll: [[0, 0], [0.9, 2], [1.8, 0]],
      yaw: [[0, 0], [0.4, -2], [1.5, 2.5], [1.8, 0]],
    }, { blink: [1.55] }), side(rng))
  },
  bob() {
    return clip(0.55, hopTracks(3.5, 0.55 / HOP))
  },

  // ---- Sending a message on: wind up, dash toward the chat, come back.
  dash() {
    return clip(1.1, {
      x: [[0, 0], [0.22, -3.5], [0.36, 8, 'snap'], [0.62, 8, 'linear'], [0.9, -1], [1.1, 0]],
      roll: [[0, 0], [0.22, -7], [0.36, 9, 'snap'], [0.62, 6], [0.9, -2], [1.1, 0]],
      sq: [[0, 0], [0.22, 0.06], [0.34, -0.1, 'out'], [0.5, 0], [1.1, 0]],
      yaw: [[0, 0], [0.22, -3], [0.36, 4, 'snap'], [0.9, 0], [1.1, 0]],
      gx: [[0, 0], [0.18, 0.9, 'snap'], [0.8, 0.9, 'linear'], [1, 0]],
    })
  },

  // ---- Relaying in a group: leans to one side as if taking the words, then swings
  // across to pass them on. Even, both ways, unlike sending's one dash.
  relay(rng) {
    return mirror(clip(2, {
      x: [[0, 0], [0.4, -6], [0.75, -6, 'linear'], [1.2, 6], [1.6, 6, 'linear'], [2, 0]],
      roll: [[0, 0], [0.4, -6], [0.75, -6, 'linear'], [1.2, 6], [1.6, 6, 'linear'], [2, 0]],
      yaw: [[0, 0], [0.4, -4.5], [0.75, -4.5, 'linear'], [1.2, 4], [1.6, 4, 'linear'], [2, 0]],
      gx: [[0, 0], [0.1, -0.85, 'snap'], [0.75, -0.85, 'linear'], [0.85, 0.85, 'snap'], [1.6, 0.85, 'linear'], [1.9, 0]],
    }, { blink: [0.8] }), side(rng))
  },

  // ---- Waiting on other Bots: taps its foot, three quick small hops on the spot, and
  // looks over to where the work went.
  tap() {
    return clip(0.96, {
      y: [[0, 0], [0.1, -3.5, 'out'], [0.2, 0, 'in'], [0.42, -3.5, 'out'], [0.52, 0, 'in'], [0.74, -3.5, 'out'], [0.84, 0, 'in'], [0.96, 0]],
      sq: [[0, 0], [0.2, 0.045, 'out'], [0.3, 0], [0.52, 0.045, 'out'], [0.62, 0], [0.84, 0.045, 'out'], [0.96, 0]],
    })
  },
  // Looks over to one side, where the work went, and leans after it for a while.
  patient(rng) {
    const hold = 0.8 + rng() * 0.8
    return mirror(clip(1.2 + hold, {
      x: [[0, 0], [0.6, 3.5], [0.6 + hold, 3.5, 'linear'], [1.2 + hold, 0]],
      roll: [[0, 0], [0.6, 5], [0.6 + hold, 5, 'linear'], [1.2 + hold, 0]],
      yaw: [[0, 0], [0.6, 3], [0.6 + hold, 3, 'linear'], [1.2 + hold, 0]],
      gx: [[0, 0], [0.12, 0.8, 'snap'], [0.7 + hold, 0.8, 'linear'], [1.1 + hold, 0]],
    }), side(rng))
  },
  sigh() {
    return clip(1.5, {
      sq: [[0, 0], [0.5, -0.04], [1.1, 0.05], [1.5, 0]],
      lid: [[0, 0], [0.9, 0.4], [1.4, 0]],
      pitch: [[0, 0], [0.5, -2], [1.1, 4], [1.5, 0]],
    })
  },

  // ---- Background tasks: working's nod, at half its pace: busy, but calmly.
  hum() {
    return clip(1.4, {
      pitch: [[0, 0], [0.3, 9, 'out'], [0.7, 0], [1, 8, 'out'], [1.4, 0]],
      y: [[0, 0], [0.3, 4.5, 'out'], [0.7, 0], [1, 4, 'out'], [1.4, 0]],
      sq: [[0, 0], [0.3, 0.05, 'out'], [0.7, 0], [1, 0.045, 'out'], [1.4, 0]],
    })
  },

  // ---- Needs you: two hops to catch your eye, and two smaller ones every few seconds
  // until you answer.
  attention() {
    return clip(0.96, {
      y: [[0, 0], [0.08, 0.6, 'out'], [0.24, -10, 'out'], [0.4, 0, 'in'], [0.46, 0.4, 'out'], [0.6, -7, 'out'], [0.76, 0, 'in'], [0.96, 0]],
      sq: [[0, 0], [0.08, 0.07, 'out'], [0.16, -0.08, 'out'], [0.3, 0], [0.4, 0.1, 'out'], [0.5, -0.06, 'out'], [0.64, 0], [0.76, 0.08, 'out'], [0.86, -0.02], [0.96, 0]],
      pupil: [[0, 0], [0.24, 0.08], [0.6, 0.06], [0.96, 0]],
    })
  },
  call() {
    return clip(0.9, {
      y: [[0, 0], [0.07, 0.5, 'out'], [0.22, -7, 'out'], [0.38, 0, 'in'], [0.44, 0.4, 'out'], [0.58, -5, 'out'], [0.74, 0, 'in'], [0.9, 0]],
      sq: [[0, 0], [0.07, 0.06, 'out'], [0.15, -0.07, 'out'], [0.3, 0], [0.38, 0.08, 'out'], [0.47, -0.05, 'out'], [0.6, 0], [0.74, 0.06, 'out'], [0.82, -0.015], [0.9, 0]],
      scale: [[0, 0], [0.22, 0.04], [0.58, 0.03], [0.9, 0]],
      pupil: [[0, 0], [0.22, 0.06], [0.9, 0]],
    })
  },

  // ---- Failed: shakes its head, no, and sinks with a sigh now and then.
  shake() {
    return clip(0.8, {
      x: [[0, 0], [0.1, 5, 'out'], [0.24, -5], [0.38, 4.2], [0.52, -3.2], [0.66, 1.2], [0.8, 0]],
      roll: [[0, 0], [0.1, 6, 'out'], [0.24, -6], [0.38, 5], [0.52, -3.5], [0.66, 1.2], [0.8, 0]],
      yaw: [[0, 0], [0.1, 3], [0.24, -3], [0.38, 2.5], [0.52, -2], [0.8, 0]],
    })
  },
  slump() {
    return clip(1.6, {
      y: [[0, 0], [0.5, -1.2], [1.1, 2.6, 'in'], [1.6, 0]],
      sq: [[0, 0], [0.5, -0.04], [1.1, 0.07, 'out'], [1.6, 0]],
      pitch: [[0, 0], [0.5, -3], [1.1, 5], [1.6, 0]],
      lid: [[0, 0], [0.9, 0.35], [1.5, 0]],
    })
  },

  // ---- Done: a small celebration, not the same one every time.
  celebrate() {
    return clip(1.15, {
      ...hopTracks(14),
      yaw: [[0, 0], [0.1, -12, 'out'], [0.62, 360, 'inOut'], [1.15, 360, 'linear']],
    }, { commit: true, face: [[0.14, 'happy']], accent: 'sparkle' })
  },
  nodHappy() {
    return clip(0.82, {
      pitch: [[0, 0], [0.18, 9, 'out'], [0.38, -2], [0.54, 6, 'out'], [0.78, 0]],
      y: [[0, 0], [0.18, 1.4, 'out'], [0.38, 0], [0.54, 1, 'out'], [0.78, 0]],
    }, { face: [[0.06, 'happy']], accent: 'sparkle' })
  },
  hopHappy(rng) {
    return clip(0.84, { ...hopTracks(jitter(rng, 10)), pupil: [[0, 0], [0.3, 0.06], [0.84, 0]] }, { face: [[0.08, 'happy']], accent: 'sparkle' })
  },

  // ---- Asleep: now and then one eye opens a crack, looks to one side, then at you,
  // and shuts quickly, as if it was never awake.
  sneak(rng) {
    const s = side(rng)
    const hold = 0.45 + rng() * 0.5
    const back = 0.95 + hold
    return clip(back + 1, {
      gx: [[0, 0], [0.32, 0, 'linear'], [0.44, 0.7 * s, 'snap'], [0.44 + hold, 0.7 * s, 'linear'], [0.58 + hold, 0, 'snap'], [back + 0.4, 0, 'linear'], [back + 0.75, 0]],
      gy: [[0, 0], [0.32, 0, 'linear'], [0.44, 0.15, 'snap'], [0.44 + hold, 0.15, 'linear'], [0.58 + hold, 0, 'snap'], [back + 1, 0]],
      pitch: [[0, 0], [0.4, -2.5], [back + 0.3, -2.5, 'linear'], [back + 1, 0]],
      y: [[0, 0], [0.4, -0.6], [back + 0.3, -0.6, 'linear'], [back + 1, 0]],
    }, { face: [[0.12, 'peek'], [back + 0.35, null]] })
  },

  // ---- Waking from a doze.
  wake() {
    return clip(1.2, {
      sq: [[0, 0], [0.2, 0.05], [0.5, -0.1, 'out'], [0.8, 0.03], [1.2, 0]],
      pitch: [[0, 0], [0.5, -6], [1.2, 0]],
      y: [[0, 0], [0.5, -1.5], [1.2, 0]],
    }, { face: [[0, 'surprised'], [0.4, null]], blink: [0.5] })
  },

  // ---- Answers to the pointer.
  // A poke: one bounce, then a spin, then two, then it gets dizzy.
  pokeBounce(rng) {
    return clip(0.7, { ...hopTracks(jitter(rng, 8, 0.1), 0.7 / HOP), pupil: [[0, 0], [0.12, 0.1, 'out'], [0.5, 0], [0.7, 0]] }, { face: [[0.06, 'happy'], [0.62, null]] })
  },
  pokeSpin() {
    return clip(0.9, {
      ...hopTracks(8),
      yaw: [[0, 0], [0.08, -10, 'out'], [0.62, 360, 'inOut'], [0.9, 360, 'linear']],
    }, { commit: true, face: [[0.1, 'happy'], [0.82, null]], accent: 'confetti' })
  },
  pokeSpin2() {
    return clip(1.25, {
      ...hopTracks(12),
      yaw: [[0, 0], [0.1, -14, 'out'], [0.95, 720, 'inOut'], [1.25, 720, 'linear']],
    }, { commit: true, face: [[0.1, 'happy'], [1.15, null]], accent: 'confetti' })
  },
  dizzy() {
    return clip(1.9, {
      roll: [[0, 0], [0.2, 12], [0.45, -10], [0.7, 8], [0.95, -6], [1.2, 4], [1.45, -2], [1.7, 0]],
      yaw: [[0, 0], [0.3, -5], [0.6, 4], [0.9, -3], [1.2, 2], [1.6, 0]],
      x: [[0, 0], [0.25, 2], [0.55, -2], [0.85, 1.5], [1.15, -1], [1.5, 0]],
      y: [[0, 0], [0.4, 1], [1.9, 0]],
    }, { commit: true, face: [[0, 'dizzy'], [1.65, null]], blink: [1.66] })
  },
  // Petting: leans into the pointer and purrs.
  nuzzle(rng) {
    return mirror(clip(0.85, {
      roll: [[0, 0], [0.42, 4], [0.85, 0]],
      sq: [[0, 0], [0.42, 0.025], [0.85, 0]],
      y: [[0, 0], [0.42, 0.4], [0.85, 0]],
    }), side(rng))
  },
  // A new Bot arrives.
  appear() {
    return clip(0.8, {
      scale: [[0, -0.55], [0.28, 0.08, 'out'], [0.46, -0.025], [0.62, 0], [0.8, 0]],
      y: [[0, 5], [0.28, -3, 'out'], [0.5, 0], [0.8, 0]],
      sq: [[0, 0], [0.28, -0.06], [0.46, 0.05], [0.62, 0], [0.8, 0]],
    }, { commit: true, face: [[0.32, 'happy'], [0.74, null]] })
  },
}

// Blinks are clips too: a fast close and a slower open that overshoots a little.
export const blinkClip = (double = false) => clip(double ? 0.5 : 0.26, {
  lid: double
    ? [[0, 0], [0.065, 1, 'in'], [0.1, 1, 'linear'], [0.2, 0, 'out'], [0.27, 0, 'linear'], [0.33, 1, 'in'], [0.36, 1, 'linear'], [0.5, 0, 'out']]
    : [[0, 0], [0.07, 1, 'in'], [0.11, 1, 'linear'], [0.26, 0, 'out']],
  pupil: double ? [[0, 0], [0.2, 0.03], [0.27, 0], [0.45, 0.03], [0.5, 0]] : [[0, 0], [0.2, 0.03], [0.26, 0]],
})
