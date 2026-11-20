// Every DS Bot stylesheet goes through installStyles (styles.js), so the corner and text
// sizes written there in px follow the appearance without each module knowing about it:
// `--bt-r` scales corners and `--bt-fs` scales text. Unset, both are 1 and nothing moves.
// Circles (50%) and pills (999px) keep their shape. Running it twice changes nothing.

const RADIUS = /(border(?:-[a-z]+)*-radius\s*:\s*)([^;}]+)/g
const TEXT = /((?:^|[;{\s])(?:font-size|line-height)\s*:\s*)(\d+(?:\.\d+)?)px/g
const PX = /(?<![\w.-])(\d+(?:\.\d+)?)px/g
// Sizes from here on are pills: a corner that big is a full round end at any size.
const PILL_PX = 100

const corners = value => value.replace(PX, (whole, size) => {
  const px = Number(size)
  return px > 0 && px < PILL_PX ? `calc(${size}px*var(--bt-r,1))` : whole
})

/**
 * @param {string} css
 * @returns {string} the same rules with px corners and px text sizes scaled
 */
export function scaleCss(css) {
  return String(css)
    .replace(RADIUS, (whole, head, value) => (value.includes('--bt-r') ? whole : head + corners(value)))
    .replace(TEXT, (whole, head, size) => `${head}calc(${size}px*var(--bt-fs,1))`)
}
