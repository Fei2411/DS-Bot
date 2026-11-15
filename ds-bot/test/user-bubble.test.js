import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ACCENT_INKS, INKS, luminance } from '../src/client/inks.js'
import { allThemes, shellTokens, themeCss } from '../src/client/themes.js'

// The browser bundle holds every style sheet ds-bot installs; the bundle test
// keeps it in step with src/client.
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// CSS declaration blocks hold no braces, so a declaration's rule runs from the
// nearest `{` before it to the nearest `}` after it.
function rulesWith(pattern) {
  const rules = []
  for (const match of bundle.matchAll(pattern)) {
    const open = bundle.lastIndexOf('{', match.index)
    const close = bundle.indexOf('}', match.index)
    const start = Math.max(bundle.lastIndexOf('}', open), bundle.lastIndexOf('\n', open), bundle.lastIndexOf('`', open)) + 1
    rules.push({ selector: bundle.slice(start, open).trim(), body: bundle.slice(open + 1, close) })
  }
  return rules
}
const declared = (body, property) => body.split(';').map(item => item.trim()).find(item => item.startsWith(`${property}:`))?.slice(property.length + 1)
const surface = body => declared(body, 'background') ?? declared(body, 'background-color')
const ruleFor = selector => {
  const rule = rulesWith(/color:var\(--bt-user-ink\)/g).find(item => item.selector.startsWith(selector))
  assert.ok(rule, `no rule for ${selector}`)
  return rule
}

test('every rule that writes in the user ink paints the user surface under it', () => {
  const rules = rulesWith(/(?<=[{;])color:var\(--bt-user-ink\)/g)
  assert.ok(rules.length >= 3)
  for (const { selector, body } of rules) {
    assert.match(surface(body) ?? '', /^var\(--bt-user\)(!important)?$/, selector)
  }
})

test('no ds-bot text color sits on a surface that a skin owns', () => {
  for (const { selector, body } of rulesWith(/(?<=[{;])color:var\(--bt-/g)) {
    assert.doesNotMatch(surface(body) ?? '', /--dsw-/, selector)
  }
})

test('ds-bot leaves the host bubble variables to the host and its skins', () => {
  assert.doesNotMatch(bundle, /--dsw-specific-bubble/)
  assert.doesNotMatch(bundle, /conversationTokens|installBubbleTokens/)
  for (const [id, theme] of Object.entries(allThemes())) {
    assert.deepEqual(Object.keys(shellTokens(theme)).filter(name => name.includes('bubble')), [], id)
  }
})

const themeVars = (theme, dark) => {
  const block = themeCss(theme).split('\n').find(line => line.startsWith(dark ? 'html body[data-ds-dark-theme]{' : 'html body{'))
  return Object.fromEntries(block.slice(block.indexOf('{') + 1, -1).split(';').map(item => item.split(':')))
}
const parse = color => {
  if (/^#[0-9a-f]{6}$/i.test(color)) return { hex: color.toLowerCase(), alpha: 1 }
  const parts = color.match(/^rgba?\(([^)]+)\)$/)[1].split(',').map(Number)
  return { hex: `#${parts.slice(0, 3).map(part => part.toString(16).padStart(2, '0')).join('')}`, alpha: parts[3] ?? 1 }
}
const over = (top, under) => {
  const { hex, alpha } = parse(top)
  if (alpha === 1) return hex
  const channel = (color, index) => parseInt(color.slice(index, index + 2), 16)
  return `#${[1, 3, 5].map(index => Math.round(channel(hex, index) * alpha + channel(under, index) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}
const contrast = (ink, paper) => {
  const [a, b] = [luminance(ink), luminance(paper)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

test('the user ink reads on the user surface in every built-in theme and mode', () => {
  for (const id of ['deepseek', 'mono', 'paper', 'moonlight']) {
    for (const dark of [false, true]) {
      const vars = themeVars(allThemes()[id], dark)
      const ratio = contrast(over(vars['--bt-user-ink'], vars['--bt-user']), over(vars['--bt-user'], vars['--bt-main']))
      assert.ok(ratio >= 4.5, `${id} ${dark ? 'dark' : 'light'}: ${ratio.toFixed(2)}:1`)
    }
  }
})

// Text on the accent (send key, new-message pill, primary buttons) takes whichever
// of the two inks reads better: white on Tangerine was 2.89:1, near-black is 6.38:1.
// The variables themeCss sets for one mode.
const varsOf = (theme, accent, dark) => {
  const block = themeCss(theme, accent).split('\n').find(line => line.startsWith(dark ? 'html body[data-ds-dark-theme]{' : 'html body{'))
  return Object.fromEntries(block.slice(block.indexOf('{') + 1, -1).split(';').map(item => item.split(':')))
}

test('the accent ink is the more readable of the two inks for every accent', () => {
  const cases = []
  for (const id of ['deepseek', 'mono', 'paper', 'moonlight']) {
    for (const dark of [false, true]) cases.push([`${id} ${dark ? 'dark' : 'light'}`, allThemes()[id], undefined, dark])
  }
  for (const ink of ACCENT_INKS) {
    for (const dark of [false, true]) cases.push([`${ink} ${dark ? 'dark' : 'light'}`, allThemes().deepseek, INKS[ink][0], dark])
  }
  for (const [name, theme, accent, dark] of cases) {
    const vars = varsOf(theme, accent, dark)
    const paper = vars['--bt-accent'], ink = vars['--bt-accent-ink']
    const other = ink === '#ffffff' ? '#141414' : '#ffffff'
    assert.ok(contrast(ink, paper) >= contrast(other, paper), `${name}: ${ink} on ${paper} is ${contrast(ink, paper).toFixed(2)}:1, ${other} would be ${contrast(other, paper).toFixed(2)}:1`)
  }
})

// A preset accent is saved as its light value. Dark mode used it too, so Charcoal
// (#141416) was 1.00:1 on the dark background, Graphite 1.34:1 and Cobalt 2.48:1.
test('a preset accent takes its dark value in dark mode; a custom accent stays the same', () => {
  for (const [id, theme] of Object.entries(allThemes())) {
    for (const ink of ACCENT_INKS) {
      const [light, dark] = INKS[ink]
      assert.equal(varsOf(theme, light, false)['--bt-accent'], light)
      assert.equal(varsOf(theme, light, true)['--bt-accent'], dark, `${id} ${ink}`)
      const ratio = contrast(dark, theme.dark.bg)
      assert.ok(ratio >= 3, `${id} ${ink}: ${dark} on ${theme.dark.bg} is ${ratio.toFixed(2)}:1`)
    }
    // A color picked by hand is not a preset, even when it spells one in lower case.
    for (const custom of ['#123456', INKS.deepseek[0].toLowerCase()]) {
      assert.equal(varsOf(theme, custom, true)['--bt-accent'], custom)
    }
    assert.equal(varsOf(theme, undefined, true)['--bt-accent'], theme.dark.accent)
  }
})

// UI standard §14 #1: the danger red was written out as #e02135 and #c21d2e in 22
// places. Every danger color reads --bt-danger, which the base sheet sets once.
test('every danger color reads --bt-danger, which the base sheet sets once', () => {
  assert.equal([...bundle.matchAll(/--bt-danger:#e02135/g)].length, 1)
  const allowed = before => before.endsWith('--bt-danger:') // the one value
    || before.endsWith('var(--bt-danger,') // feedback.js: its toast shows without the base sheet too
    || before.endsWith('.bt-voice-end:hover{background:') // recording reds: not decided yet
    || /FF3E51['"],\s*['"]$/i.test(before) // the red Bot color, not a danger color
  const loose = [...bundle.matchAll(/#e02135|#c21d2e/gi)]
    .map(match => bundle.slice(Math.max(0, match.index - 40), match.index))
    .filter(before => !allowed(before))
  assert.deepEqual(loose, [])
})

// A dark skin repaints the host bubble surface (dsh-dream-skin's underwater theme
// sets this value) and leaves ds-bot's colors alone.
const DARK_SKIN = { '--dsw-specific-bubble': 'rgba(31,33,38,.92)', '--dsw-alias-label-primary': '#ffffff' }
const resolve = (value, vars) => {
  const plain = value.replace(/!important$/, '')
  const match = plain.match(/^var\((--[\w-]+)(?:,(.+))?\)$/)
  if (!match) return plain
  if (vars[match[1]] !== undefined) return resolve(vars[match[1]], vars)
  assert.ok(match[2] !== undefined, `${match[1]} is unset`)
  return resolve(match[2], vars)
}

test('a user message stays readable when a dark skin repaints the host bubble', () => {
  for (const id of ['deepseek', 'mono', 'paper', 'moonlight']) {
    const vars = { ...themeVars(allThemes()[id], true), ...DARK_SKIN }
    const page = vars['--bt-main']
    for (const selector of ['.bt-ubody', '[class*="_userRow"] [class*="_bubble"]']) {
      const { body } = ruleFor(selector)
      const paper = over(resolve(surface(body), vars), page)
      const ink = over(resolve(declared(body, 'color'), vars), paper)
      assert.ok(contrast(ink, paper) >= 4.5, `${id} ${selector}: ${contrast(ink, paper).toFixed(2)}:1`)
    }
  }
})

test('the surface wins over the host bubble rule that reads the skin variable', () => {
  const { body } = ruleFor('[class*="_userRow"] [class*="_bubble"]')
  assert.equal(surface(body), 'var(--bt-user)!important')
  assert.equal(declared(body, 'color'), 'var(--bt-user-ink)!important')
})

// The wallpaper engine's glass (body[data-we-glass-page][data-we-thinking-glass]
// [class*="_bubble"]) sets only background-color, with !important and a higher
// specificity than the rule above. The text kept the user ink on a surface that was
// now glass: 1.0:1 in dark mode, 1.4:1 in light mode. The user surface is also an
// opaque image layer, which no background-color can replace.
test('a skin that repaints only the bubble background-color leaves the user surface under the text', () => {
  const { body } = ruleFor('[class*="_userRow"] [class*="_bubble"]')
  assert.equal(declared(body, 'background-image'), 'linear-gradient(var(--bt-user),var(--bt-user))!important')
  for (const [id, theme] of Object.entries(allThemes())) {
    for (const dark of [false, true]) {
      const vars = themeVars(theme, dark)
      assert.equal(parse(vars['--bt-user']).alpha, 1, `${id} ${dark ? 'dark' : 'light'}: the user surface must be opaque`)
    }
  }
})
