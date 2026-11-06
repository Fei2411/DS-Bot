// Finds the colors, corner radii and springs in src/client that skip the shared ones.
// test/style-debt.json lists the ones written before the check; the test fails when a
// file gets one more, and when one is gone but still listed.
//
//   node scripts/style-debt.mjs           prints what it finds now
//   node scripts/style-debt.mjs --write   lowers test/style-debt.json to what is left
//
// --write only lowers counts. A new entry is added by hand, so it shows in review.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(import.meta.dirname, '..')
const CLIENT = join(PLUGIN, 'src', 'client')
export const DEBT = join(PLUGIN, 'test', 'style-debt.json')

// The theme colors, the Bot colors, the generated characters and the service logos.
const PALETTES = new Set(['themes.js', 'inks.js', 'characters.js', 'connector-marks.js'])
export const RADII = ['0', '4px', '6px', '8px', '10px', '12px', '16px', '18px', '20px', '22px', '999px', '50%', 'inherit']

const COLOR = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/gi
// Named colors count in the value of a CSS declaration that takes a color. A quoted
// value is JavaScript data, such as a Bot's color name, not CSS.
const NAMES = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
  + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen '
  + 'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray '
  + 'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia '
  + 'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender '
  + 'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink '
  + 'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon '
  + 'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
  + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
  + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red '
  + 'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ')
const NAMED = new RegExp(`(?<![\\w-])(?:${NAMES.join('|')})(?![\\w-])`, 'gi')
const TAKES_COLOR = /(?<![\w-])(--[\w-]+|color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|(?:box|text)-shadow|(?:caret|accent|text-decoration|column-rule)(?:-color)?)\s*:\s*([^;{}'"`]*)/g
const RADIUS = new RegExp([
  /border(?:-[a-z]+)*-radius\s*:\s*((?:\$\{[^}]*\}|[^;{}`'"])+)/.source,
  /['"]?\bborder\w*Radius['"]?\s*[:=]\s*['"]?((?:\$\{[^}]*\}|[^,;}'"])+)/.source,
  /setProperty\(\s*['"]border(?:-[a-z]+)*-radius['"]\s*,\s*['"]((?:\$\{[^}]*\}|[^'"])+)/.source,
].join('|'), 'g')
const SPRING = /\bspringEasing\([^)]*\)|\blinear\([^)]*\)/g

// Every literal color in `text` and where it starts.
function* colorLiterals(text) {
  for (const { 0: value, index } of text.matchAll(COLOR)) yield { value: plain(value), index }
  for (const declaration of text.matchAll(TAKES_COLOR)) {
    const start = declaration.index + declaration[0].length - declaration[2].length
    for (const { 0: value, index } of declaration[2].matchAll(NAMED)) yield { value: value.toLowerCase(), index: start + index }
  }
}

// The gradient(…) that holds `index`, or ''.
function gradientAround(line, index) {
  const start = line.lastIndexOf('gradient(', index)
  if (start < 0) return ''
  let depth = 0
  for (let at = start; at < line.length; at += 1) {
    if (line[at] === '(') depth += 1
    else if (line[at] === ')' && --depth === 0) return at > index ? line.slice(start, at + 1) : ''
  }
  return ''
}

// `before` ends inside a --bt-* declaration of the base sheet's body rules, where the
// theme variables get their default values.
function definesToken(before) {
  const open = before.lastIndexOf('{')
  if (open < 0 || !/--bt-[\w-]+\s*:[^;{}]*$/.test(before)) return false
  const selector = before.slice(Math.max(before.lastIndexOf('}', open), before.lastIndexOf('`', open)) + 1, open).trim()
  return /^body(?:\[[\w-]+\])?$/.test(selector)
}

// A literal color that is not a hard-coded one: a theme variable's default value, or
// black used for its alpha (shadows, scrims, and masks, whose ramps run to transparent).
function exempt(file, value, text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const end = text.indexOf('\n', index)
  const line = text.slice(start, end < 0 ? undefined : end)
  const before = line.slice(0, index - start)
  if ((file === 'styles.js' && definesToken(before)) || value.startsWith('rgba(0,0,0,')) return true
  if (!/^#000(?:000)?$/.test(value)) return false
  return /<mask\b(?!.*<\/mask>)/.test(before) || gradientAround(line, index - start).includes('transparent')
}

const squeeze = value => value.replace(/\s*([(),/])\s*/g, '$1').replace(/\s+/g, ' ').trim()
const plain = value => squeeze(value.toLowerCase())

// A step is one corner of a border-radius value; a bare number in a React style is px.
const steps = value => value.replace(/!important/g, '').replace(/\([^)]*\)/g, group => group.replace(/\s+/g, '')).trim().split(/\s*\/\s*|\s+/)
  .map(step => (/^\d*\.?\d+$/.test(step) && step !== '0' ? `${step}px` : step))

// Each check takes a file name and its code, and returns the values that skip the shared ones.
export const checks = {
  colors: (file, text) => (PALETTES.has(file) ? [] : [...colorLiterals(text)]
    .filter(({ value, index }) => !exempt(file, value, text, index))
    .map(({ value }) => value)),
  radii: (file, text) => [...text.matchAll(RADIUS)]
    .flatMap(match => steps(match[1] ?? match[2] ?? match[3]))
    .filter(step => !RADII.includes(step) && !step.startsWith('var(')),
  springs: (file, text) => (file === 'motion.js' ? [] : [...text.matchAll(SPRING)].map(({ 0: call }) => squeeze(call))),
}

// Comments are not styles. A trailing comment follows a space, which a URL's `://` lacks.
const code = text => text.split(/\r?\n/)
  .map(line => (/^\s*(\/\/|\/\*|\*\/|\*\s|\*$)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
  .join('\n')

export function findStyles(dir = CLIENT) {
  const found = Object.fromEntries(Object.keys(checks).map(kind => [kind, {}]))
  for (const file of readdirSync(dir, { recursive: true }).filter(name => name.endsWith('.js')).map(name => name.replaceAll('\\', '/'))) {
    const text = code(readFileSync(join(dir, file), 'utf8'))
    for (const [kind, check] of Object.entries(checks)) {
      for (const value of check(file, text)) {
        const counts = (found[kind][file] ??= {})
        counts[value] = (counts[value] ?? 0) + 1
      }
    }
  }
  return found
}

export const readDebt = () => JSON.parse(readFileSync(DEBT, 'utf8'))

// Each listed entry keeps the smaller of its listed and its found count.
export function lowered(debt, found) {
  return Object.fromEntries(Object.entries(debt).map(([kind, files]) => [kind, Object.fromEntries(Object.entries(files)
    .map(([file, values]) => [file, Object.fromEntries(Object.entries(values)
      .map(([value, count]) => [value, Math.min(count, found[kind]?.[file]?.[value] ?? 0)])
      .filter(([, count]) => count > 0))])
    .filter(([, values]) => Object.keys(values).length > 0))]))
}

const sorted = item => (typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, sorted(value)]))
  : item)
const format = debt => `${JSON.stringify(sorted(debt), null, 2)}\n`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findStyles()
  if (process.argv.includes('--write')) writeFileSync(DEBT, format(lowered(readDebt(), found)))
  else process.stdout.write(format(found))
}
