import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ROUTE } from '../src/host/constants.js'
import { FONT_DIR, install } from '../src/host/fonts.js'
import { FONT_FILES, FONT_RANGES, FONT_ROUTE, REPLY_FACES, REPLY_FAMILY } from '../src/shared/reply-fonts.js'
import { allThemes, themeCss } from '../src/client/themes.js'
import { botOwnCss } from '../src/client/styles.js'
import { THEMES as SKIN_THEMES } from './skin-themes.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('every reply font ships as WOFF2 with its license, inside the npm package', () => {
  for (const file of Object.values(FONT_FILES)) {
    const bytes = readFileSync(new URL(file, FONT_DIR))
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${file} is WOFF2`)
  }
  for (const license of ['OFL-source-serif-4.txt', 'OFL-noto-serif-sc.txt']) {
    assert.match(readFileSync(new URL(license, FONT_DIR), 'utf8'), /SIL OPEN FONT LICENSE/i, license)
  }
  assert.ok(pkg.files.includes('assets/'), 'package.json files publishes assets/')
})

// A browser joins faces by unicode-range only among faces with the same weight and
// style; a Chinese face with other descriptors is never used for Latin-styled text.
test('every reply face has a partner for the other script with the same weight and style', () => {
  const groups = new Map()
  for (const face of REPLY_FACES) {
    assert.ok(Object.hasOwn(FONT_RANGES, face.range), `${face.file} names a known range`)
    const key = `${face.style} ${face.weight}`
    groups.set(key, [...(groups.get(key) ?? []), face.range])
  }
  for (const [key, ranges] of groups) assert.deepEqual(ranges.toSorted(), ['cjk', 'latin'], key)
  // Every weight from 100 to 900 lands in one group, upright and italic.
  for (const style of ['normal', 'italic']) {
    for (let weight = 100; weight <= 900; weight += 100) {
      const hits = [...groups.keys()].filter(key => {
        const [s, low, high] = key.split(' ')
        return s === style && weight >= Number(low) && weight <= Number(high)
      })
      assert.equal(hits.length, 1, `${style} ${weight}`)
    }
  }
})

test('the host serves each reply font on the route the client asks for', async () => {
  const routes = new Map()
  const ctx = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } },
  }
  install({ ctx })
  assert.equal(`/${FONT_ROUTE}`, `${ROUTE}/fonts`)
  for (const file of Object.values(FONT_FILES)) {
    const route = routes.get(`/${FONT_ROUTE}/${file}`)
    assert.ok(route, `route for ${file}`)
    assert.deepEqual(route.methods, ['GET'])
    const response = await route.fetch(new Request(`http://127.0.0.1/${FONT_ROUTE}/${file}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'font/woff2')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL(file, FONT_DIR)))
    // A rebuilt font must reach the browser at once: it revalidates by tag instead of caching for a time.
    assert.equal(response.headers.get('cache-control'), 'no-cache')
    const etag = response.headers.get('etag')
    assert.ok(etag)
    const again = await route.fetch(new Request(`http://127.0.0.1/${FONT_ROUTE}/${file}`, { headers: { 'if-none-match': etag } }))
    assert.equal(again.status, 304)
  }
  assert.equal(routes.size, Object.keys(FONT_FILES).length)
})

test('Fei sets the serif on Bot replies only, and a text font from Settings still wins', () => {
  const css = themeCss(allThemes().fei)
  for (const file of Object.values(FONT_FILES)) assert.ok(css.includes(`url(${FONT_ROUTE}/${file})`), `@font-face for ${file}`)
  const rule = css.split('\n').find(line => line.startsWith('.bt-look-bot,'))
  assert.ok(rule, 'reply rule')
  // The user's text font comes first and the serif is its fallback; test/browser/reply-font.test.js
  // checks the computed fonts against DSH's own style sheets.
  assert.ok(rule.includes(`font-family:var(--dsh-font-family-text,"${REPLY_FAMILY}"`), rule)
  // Rebinding DSH's font variables would reach code-block chrome but not the Markdown tokens.
  assert.doesNotMatch(css, /--dsw-font-family:|--ds-font-family-code/)
  // Only the Markdown inside the bubble: the bubble also holds interface parts (the fold note and button).
  assert.ok(!rule.split('{')[0].split(',').includes('.bt-bubble'), rule)
  // The model picker's greeting stands for the Bot's first message.
  assert.ok(rule.split('{')[0].split(',').includes('.bt-model-dock .bt-bubble'), rule)
  // Settings installs the theme through botOwnCss, which keeps only its own selectors:
  // the faces and the rule for the Appearance preview and the model picker survive it.
  const own = botOwnCss(css)
  assert.equal(own.match(/@font-face\{/g)?.length, REPLY_FACES.length)
  assert.ok(own.includes('.bt-look-bot,.bt-model-dock .bt-bubble{font-family:var(--dsh-font-family-text,'))
  // The other built-in themes keep the interface font.
  for (const id of ['deepseek', 'mono', 'paper', 'moonlight']) assert.doesNotMatch(themeCss(allThemes()[id]), /@font-face/)
})

test('the skin test colors match every built-in theme', () => {
  for (const [id, theme] of Object.entries(allThemes())) {
    assert.deepEqual(SKIN_THEMES[id], { light: theme.light, dark: theme.dark }, id)
  }
  assert.deepEqual(Object.keys(SKIN_THEMES), Object.keys(allThemes()))
})
