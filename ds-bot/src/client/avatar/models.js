import { capsule, clipBelow, circle2, box2, box512, ellipsoid, extrude, outline, polygonDistance, puffy, rad, roundBox, roundCone, smin, sphere, torus } from './sdf.js'
import { SQUIRCLE_BODY, STAR_BODY } from './outlines.js'

// The 3D models behind DS Bot's characters, each a signed distance in object space
// (x right, y up, z toward the viewer, about two units across).
// `eyes` are [x, y] spots on the front, found by a ray along -z; `eye` scales the
// capsule (1 = 10 by 23 units at a face-on spot). `paints` are decals on the model's
// front: a region (negative inside) of the surface point, drawn in a fixed color over
// the body color.

// The view every character is drawn from at rest: its face turned to the viewer's
// right, its top tipped toward the viewer, leaning back a little. The engine turns a
// character away from this view and back.
export const VIEW = Object.freeze({ yaw: 34, pitch: 16, roll: 10 })

// Picker order (4 rows of 5): hero & sky, cute creatures, nature & soft forms, then
// classic toys. Legacy shapes (magnet, ring, gem) follow at the end so existing Bots
// keep rendering while staying out of the picker.
export const ORDER = [
  'whale', 'star', 'moon', 'cloud', 'spark',
  'bear', 'puppy', 'kitty', 'bunny', 'octopus',
  'sprout', 'bloom', 'acorn', 'squircle', 'gumdrop',
  'peanut', 'saucer', 'beacon', 'pebbles', 'plus',
]

// `grid` is the resolution of the baked 2D outlines (star, squircle).
export function createModels({ grid = 260 } = {}) {
  const starOutline = outline([STAR_BODY], { ...box512(256, 262), grow: 22, grid })
  const squircleOutline = outline([SQUIRCLE_BODY], { ...box512(256, 256), grid })
  // Core characters: the Main Bot whale, original sky/creature/nature characters, and
  // clean geometric forms. None use third-party mascot outlines or logos.
  const MASCOTS = {
    whale: {
      label: 'Whale',
      keepShading: true,
      // The flukes are thin; a live mark meshes it finer.
      cell: 0.036,
      sdf: smin(0.14,
        ellipsoid([0.12, -0.06, 0], [0.8, 0.68, 0.66]),
        roundCone([-0.42, -0.34, 0], [-1.0, 0.16, 0], 0.18, 0.065),
        ellipsoid([-0.96, 0.5, 0], [0.13, 0.36, 0.09], 14),
        ellipsoid([-1.28, 0.22, 0], [0.13, 0.34, 0.09], 74)),
      eyes: [[-0.06, 0.12], [0.34, 0.12]],
      paints: [{ region: p => Math.max(sphere([0.42, -0.98, 0.52], 0.72)(p), -0.04 - p[2]), fill: '#fff', opacity: 1 }],
    },
    star: {
      label: 'Star',
      sdf: puffy(starOutline, 0.1, 0.2),
      prepare: [starOutline],
      eyes: [[-0.17, -0.02], [0.17, -0.02]],
      eye: 0.85,
    },
    moon: {
      label: 'Moon',
      sdf: extrude((x, y) => {
        const outer = circle2(0.06, 0, 0.88)(x, y)
        const inner = circle2(-0.52, 0.24, 0.69)(x, y)
        const k = 0.14
        const h = Math.max(k - Math.abs(outer + inner), 0) / k
        return Math.max(outer, -inner) + (h * h * k) / 4
      }, 0.14, 0.22),
      eyes: [[0.14, -0.1], [0.48, -0.1]],
      eye: 0.82,
    },
    cloud: {
      label: 'Cloud',
      sdf: smin(0.18,
        ellipsoid([0, -0.06, 0.04], [0.76, 0.54, 0.52]),
        ellipsoid([0, 0.34, -0.02], [0.48, 0.46, 0.44]),
        ellipsoid([-0.58, -0.1, -0.02], [0.43, 0.42, 0.4]),
        ellipsoid([0.58, -0.1, -0.02], [0.43, 0.42, 0.4])),
      eyes: [[-0.26, -0.04], [0.18, -0.04]],
      eye: 0.9,
    },
    spark: {
      label: 'Spark',
      sdf: smin(0.14,
        ellipsoid([0, -0.24, 0], [0.74, 0.66, 0.66]),
        roundCone([0.04, -0.08, 0], [-0.14, 0.88, 0], 0.54, 0.11),
        roundCone([0.36, -0.16, 0.02], [0.54, 0.36, 0], 0.28, 0.09)),
      eyes: [[-0.2, -0.2], [0.2, -0.2]],
      eye: 0.88,
    },
    bear: {
      label: 'Bear',
      sdf: smin(0.12,
        ellipsoid([0, -0.14, 0], [0.86, 0.76, 0.72]),
        sphere([-0.58, 0.56, -0.04], 0.3),
        sphere([0.58, 0.56, -0.04], 0.3)),
      eyes: [[-0.24, -0.08], [0.24, -0.08]],
      eye: 0.95,
    },
    puppy: {
      label: 'Puppy',
      sdf: smin(0.06,
        ellipsoid([0, 0.02, 0], [0.74, 0.68, 0.66]),
        capsule([-0.68, 0.3, -0.04], [-0.94, -0.34, -0.06], 0.21),
        capsule([0.68, 0.3, -0.04], [0.94, -0.34, -0.06], 0.21)),
      eyes: [[-0.22, 0.06], [0.22, 0.06]],
      eye: 0.92,
    },
    sprout: {
      label: 'Sprout',
      sdf: smin(0.06,
        ellipsoid([0, -0.22, 0], [0.76, 0.68, 0.68]),
        capsule([0, 0.36, 0], [0, 0.74, 0], 0.08),
        ellipsoid([0.38, 0.76, 0], [0.36, 0.16, 0.12], 22),
        ellipsoid([-0.34, 0.72, 0], [0.3, 0.14, 0.1], -26)),
      eyes: [[-0.22, -0.18], [0.22, -0.18]],
      eye: 0.92,
    },
    bloom: {
      label: 'Blossom',
      sdf: smin(0.05,
        ellipsoid([0, 0, 0], [0.46, 0.46, 0.38]),
        ...[0, 1, 2, 3, 4].map((i) => {
          const a = rad(90 + i * 72)
          return ellipsoid([Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0], [0.38, 0.38, 0.32])
        })),
      eyes: [[-0.19, 0], [0.19, 0]],
      eye: 0.82,
    },
    squircle: {
      label: 'Squircle',
      sdf: puffy(squircleOutline, 0.12, 0.26),
      prepare: [squircleOutline],
      eyes: [[-0.2, 0.06], [0.2, 0.06]],
    },
  }

  // The geometric characters.
  const GEOMETRIC = {
    gumdrop: {
      sdf: roundCone([0, -0.55, 0], [0, 0.55, 0], 0.82, 0.42),
      eyes: [[-0.2, 0.18], [0.2, 0.18]],
    },
    peanut: {
      sdf: smin(0.35, sphere([0, 0.42, 0], 0.6), sphere([0, -0.5, 0], 0.72)),
      eyes: [[-0.2, 0.5], [0.2, 0.5]],
      eye: 0.9,
    },
    saucer: {
      sdf: smin(0.12, ellipsoid([0, -0.25, 0], [1.05, 0.3, 1.05]), sphere([0, 0, 0], 0.56)),
      eyes: [[-0.18, 0.18], [0.18, 0.18]],
      eye: 0.8,
    },
    bunny: {
      sdf: smin(0.14, sphere([0, -0.3, 0], 0.68), ellipsoid([-0.26, 0.62, -0.05], [0.16, 0.48, 0.12], 10), ellipsoid([0.26, 0.62, -0.05], [0.16, 0.48, 0.12], -10)),
      eyes: [[-0.2, -0.22], [0.2, -0.22]],
      eye: 0.85,
    },
    kitty: {
      sdf: smin(0.12, ellipsoid([0, -0.12, 0], [0.86, 0.74, 0.72]), roundCone([-0.42, 0.4, 0], [-0.58, 0.92, 0], 0.26, 0.05), roundCone([0.42, 0.4, 0], [0.58, 0.92, 0], 0.26, 0.05)),
      eyes: [[-0.24, -0.05], [0.24, -0.05]],
    },
    beacon: {
      sdf: smin(0.05, roundBox([0, -0.22, 0], [0.82, 0.62, 0.56], 0.26), capsule([0, 0.3, 0], [0, 0.82, 0], 0.07), sphere([0, 0.9, 0], 0.16)),
      eyes: [[-0.26, -0.2], [0.26, -0.2]],
    },
    plus: {
      sdf: extrude((x, y) => Math.min(box2(0, 0, 0.82, 0.24)(x, y), box2(0, 0, 0.24, 0.82)(x, y)), 0.22, 0.14),
      eyes: [[-0.14, 0.02], [0.14, 0.02]],
      eye: 0.72,
    },
    magnet: {
      sdf: extrude((x, y) => Math.max(y < 0 ? Math.abs(Math.hypot(x, y) - 0.56) - 0.24 : Math.abs(Math.abs(x) - 0.56) - 0.24, y - 0.72), 0.22, 0.1),
      eyes: [[-0.17, -0.56], [0.17, -0.56]],
      eye: 0.72,
    },
    acorn: {
      sdf: smin(0.04, ellipsoid([0, -0.22, 0], [0.72, 0.78, 0.72]), clipBelow(ellipsoid([0, 0.3, 0], [0.88, 0.5, 0.88]), 0.16), capsule([0, 0.72, 0], [0.08, 0.98, 0], 0.08)),
      eyes: [[-0.22, -0.12], [0.22, -0.12]],
    },
    pebbles: {
      sdf: smin(0.22, roundBox([0, -0.48, 0], [0.9, 0.38, 0.62], 0.34), roundBox([0.05, 0.36, 0], [0.62, 0.4, 0.5], 0.3)),
      eyes: [[-0.16, 0.38], [0.24, 0.38]],
      eye: 0.82,
    },
    ring: {
      sdf: torus([0, 0, 0], 0.64, 0.3),
      eyes: [[-0.2, -0.64], [0.2, -0.64]],
      eye: 0.62,
    },
    gem: {
      sdf: extrude((x, y) => polygonDistance([[[-0.52, 0.56], [0.52, 0.56], [0.94, 0.12], [0, -0.86], [-0.94, 0.12]]], x, y), 0.24, 0.1),
      eyes: [[-0.2, 0.2], [0.2, 0.2]],
      eye: 0.8,
    },
    octopus: {
      label: 'Octopus',
      sdf: smin(0.15,
        ellipsoid([0, 0.18, 0], [0.74, 0.64, 0.66]),
        capsule([-0.46, -0.32, 0.08], [-0.76, -0.6, 0.18], 0.19),
        capsule([-0.16, -0.38, 0.14], [-0.24, -0.72, 0.22], 0.19),
        capsule([0.18, -0.38, 0.12], [0.26, -0.72, 0.18], 0.19),
        capsule([0.48, -0.32, 0.04], [0.76, -0.58, 0.08], 0.19)),
      eyes: [[-0.22, 0.18], [0.22, 0.18]],
      eye: 0.9,
    },
  }
  return { ...Object.fromEntries(ORDER.map(id => [id, MASCOTS[id] ?? GEOMETRIC[id]])), ...GEOMETRIC }
}
