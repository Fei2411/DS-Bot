import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { AppearanceError, contrast, patchAppearance, readAppearance, readThemeFile, themeFile } from '../src/shared/appearance.js'
import { fakeContext } from './fake-ctx.js'

// Real pictures: a 1×1 PNG and a 1×1 JPEG as image encoders write them.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
const THEME = {
  label: 'Dusk',
  light: { bg: '#fafafa', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#ffffff', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#4d6bfe' },
  dark: { bg: '#101010', sidebar: '#181818', bubble: '#262626', card: '#1c1c1c', text: '#f0f0f0', user: '#f0f0f0', userText: '#101010', accent: '#5b7bff' },
}

function start(home) {
  const ctx = fakeContext()
  let sessions = 0
  const workspaces = new Map()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { rt, call, stop: () => ctx.dispose() }
}

function team(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-appearance-'))
  const started = start(home)
  t.after(async () => {
    await started.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, ...started }
}

test('an appearance change keeps only the fields that differ from the defaults', () => {
  const appearance = patchAppearance(undefined, { radius: 60, density: 'compact', fontSize: 14, lineHeight: 1.72, mode: 'system', css: '  ' })
  assert.deepEqual(appearance, { radius: 60, density: 'compact', lineHeight: 1.7 })
  assert.deepEqual(patchAppearance(appearance, { radius: null, density: 'standard' }), { lineHeight: 1.7 })
  assert.throws(() => patchAppearance({}, { radius: 250 }), AppearanceError)
  assert.throws(() => patchAppearance({}, { colour: 'red' }), AppearanceError)
  // A font list goes inside a declaration; it may not close it.
  assert.throws(() => patchAppearance({}, { uiFont: 'Inter; } body { display:none' }), AppearanceError)
  assert.deepEqual(patchAppearance({}, { uiFont: '"LXGW WenKai", sans-serif' }), { uiFont: '"LXGW WenKai", sans-serif' })
})

test('a background keeps only the fields of its kind', () => {
  assert.deepEqual(patchAppearance({}, { background: { kind: 'gradient', from: '#FF0000', to: '#0000ff', image: 'x', blur: 0, dim: 20 } }).background,
    { kind: 'gradient', from: '#ff0000', to: '#0000ff', angle: 180, dim: 20 })
  assert.throws(() => patchAppearance({}, { background: { kind: 'image', image: 'https://example.com/a.png' } }), AppearanceError)
  assert.throws(() => patchAppearance({}, { background: { kind: 'color', color: '#fff', surface: 50 } }), AppearanceError)
})

test('a saved appearance that another version wrote reads without the fields this one cannot use', () => {
  assert.deepEqual(readAppearance({ radius: 40, density: 'airy', future: 1, background: { kind: 'video' } }), { radius: 40 })
  assert.deepEqual(readAppearance('broken'), {})
})

test('a theme file carries the theme, the appearance and its picture, but no stylesheet and nothing of the window', () => {
  const file = themeFile(THEME, { radius: 40, mode: 'dark', material: false, css: 'body{display:none}', background: { kind: 'image', image: 'a'.repeat(64), dim: 30 } }, PNG)
  assert.deepEqual(Object.keys(file.appearance).sort(), ['background', 'radius'])
  // A stylesheet written into a file by hand is not taken in either.
  assert.equal(readThemeFile(JSON.stringify({ ...file, appearance: { ...file.appearance, css: 'input[value^=a]{background:url(https://x)}' } })).appearance.css, undefined)
  const read = readThemeFile(JSON.stringify(file))
  assert.equal(read.theme.label, 'Dusk')
  assert.equal(read.image, PNG)
  // Read in, every field the file can carry is named: what it leaves out goes back to its
  // default instead of staying as the team had it.
  assert.deepEqual(read.appearance, { radius: 40, background: { kind: 'image', image: 'a'.repeat(64), dim: 30 }, density: null, uiFont: null, codeFont: null, fontSize: null, lineHeight: null })
  assert.deepEqual(patchAppearance({ radius: 140, density: 'roomy', uiFont: 'Georgia', css: 'a{}', mode: 'dark' }, readThemeFile(JSON.stringify(themeFile(THEME, {}))).appearance), { css: 'a{}', mode: 'dark' })
  // Without its picture, an image background is not carried: the team has none then.
  assert.equal(readThemeFile(JSON.stringify({ ...file, image: undefined })).appearance.background, null)
  // A font name with a control character would end the stylesheet's declarations.
  assert.throws(() => patchAppearance({}, { uiFont: 'Inter\fbody' }), AppearanceError)
  assert.throws(() => patchAppearance({}, { codeFont: 'Mono\u0000' }), AppearanceError)
  assert.throws(() => readThemeFile('{"format":"other"}'), AppearanceError)
  assert.throws(() => readThemeFile('not json'), AppearanceError)
})

test('contrast follows WCAG', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21)
  assert.ok(contrast('#777777', '#ffffff') < 4.5)
})

test('the appearance and the themes of your own are saved with the team', async (t) => {
  const { call } = team(t)
  const saved = await call('set-prefs', { appearance: { radius: 40, background: { kind: 'color', color: '#203040' } }, themes: { 'my-dusk': THEME }, theme: 'my-dusk' })
  assert.equal(saved.ok, true)
  const { prefs } = (await call('state', {})).value
  assert.deepEqual(prefs.appearance, { radius: 40, background: { kind: 'color', color: '#203040' } })
  assert.equal(prefs.themes['my-dusk'].label, 'Dusk')
  assert.equal(prefs.theme, 'my-dusk')
  // A wrong value is refused with a line the user can read.
  const refused = await call('set-prefs', { appearance: { density: 'airy' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/invalid')
  assert.match(refused.error.message, /Density/)
  assert.equal((await call('set-prefs', { themes: { dusk: THEME } })).ok, false)
  // A refused change saves none of its fields, not even the ones that passed.
  const before = (await call('state', {})).value.prefs
  assert.equal((await call('set-prefs', { theme: 'mono', appearance: { css: 'x{}' }, themes: { bad: THEME } })).ok, false)
  assert.deepEqual((await call('state', {})).value.prefs, before)
  // The theme in use goes away: the team is on the default theme again.
  await call('set-prefs', { themes: { 'my-dusk': null } })
  const after = (await call('state', {})).value.prefs
  assert.equal(after.themes, undefined)
  assert.equal(after.theme, undefined)
})


test('a paired device cannot change computer-window appearance fields', async (t) => {
  const { rt, call } = team(t)
  assert.equal((await call('set-prefs', { appearance: { css: 'body{--x:red}', material: false, mode: 'dark', uiFont: 'Inter', codeFont: 'Menlo', fontSize: 16, lineHeight: 1.8, radius: 40 } })).ok, true)
  const before = (await call('state', {})).value.prefs.appearance
  assert.deepEqual(before, { css: 'body{--x:red}', material: false, mode: 'dark', uiFont: 'Inter', codeFont: 'Menlo', fontSize: 16, lineHeight: 1.8, radius: 40 })

  for (const appearance of [{ css: 'body{display:none}' }, { css: null }, { material: true }, { mode: 'light' }, { uiFont: 'Arial' }, { codeFont: 'Courier' }, { fontSize: 12 }, { lineHeight: 1.4 }]) {
    const answer = await rt.channelCall('set-prefs', { appearance }, undefined, true)
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'bot/refused')
    assert.match(answer.error.message, /only be changed on this computer/)
  }
  assert.deepEqual((await call('state', {})).value.prefs.appearance, before)

  // Team-facing appearance fields still work for the same remote caller.
  const answer = await rt.channelCall('set-prefs', { appearance: { radius: 60, density: 'compact' } }, undefined, true)
  assert.equal(answer.ok, true)
  const after = (await call('state', {})).value.prefs.appearance
  assert.equal(after.radius, 60)
  assert.equal(after.density, 'compact')
  assert.equal(after.css, before.css)
  assert.equal(after.material, false)
})

test('a change refused after a wait leaves a save that landed during the wait', async (t) => {
  const { rt, call } = team(t)
  let refuse
  rt.resolveModel = () => new Promise((resolve, reject) => { refuse = reject })
  const slow = call('set-prefs', { defaultBotModel: 'gone/model', accent: '#112233' })
  while (refuse === undefined) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await call('set-prefs', { theme: 'mono' })).ok, true)
  refuse(Object.assign(new Error('Unknown model'), { code: 'bot/invalid' }))
  assert.equal((await slow).ok, false)
  const { prefs } = (await call('state', {})).value
  assert.equal(prefs.theme, 'mono')
  assert.equal(prefs.accent, undefined)
  assert.equal(prefs.defaultBotModel, undefined)
})

test('a background picture is checked, kept once and read back by its id', async (t) => {
  const { home, call } = team(t)
  const first = (await call('background-add', { image: PNG })).value
  assert.match(first.id, /^[0-9a-f]{64}$/)
  assert.equal(first.mime, 'image/png')
  // Picked again: the same file, counted as new so a sweep keeps it.
  const file = join(home, 'backgrounds', `${first.id}.png`)
  const old = new Date(Date.now() - 60 * 60_000)
  utimesSync(file, old, old)
  assert.equal((await call('background-add', { image: PNG })).value.id, first.id)
  assert.ok(Date.now() - statSync(file).mtimeMs < 60_000)
  // The type comes from the bytes, not from what the data URL says.
  assert.equal((await call('background-add', { image: JPEG.replace('image/jpeg', 'image/png') })).value.mime, 'image/jpeg')
  assert.equal(readdirSync(join(home, 'backgrounds')).length, 2)
  assert.equal((await call('background-add', { image: 'data:image/png;base64,aGVsbG8=' })).ok, false)
  assert.equal((await call('background-picture', { id: first.id })).value.image, PNG)
  assert.equal((await call('background-picture', { id: '../state' })).value, null)
})

test('a chat can have its own background, and pictures nothing uses are removed later', async (t) => {
  const { home, call, rt } = team(t)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'Launch', members: [chief, writer.id] })).value
  const used = (await call('background-add', { image: PNG })).value.id
  const unused = (await call('background-add', { image: JPEG })).value.id
  assert.deepEqual((await call('set-chat-background', { botId: writer.id, background: { kind: 'image', image: used, fit: 'contain' } })).value,
    { kind: 'image', image: used, fit: 'contain' })
  await call('set-chat-background', { roomId: room.id, background: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 90 } })
  const view = (await call('state', {})).value
  assert.equal(view.bots.find(bot => bot.id === writer.id).background.image, used)
  assert.equal(view.rooms.find(entry => entry.id === room.id).background.angle, 90)
  assert.equal((await call('set-chat-background', { botId: 'nobody', background: null })).error.code, 'bot/not-found')

  // A picture saved a moment ago stays, even unused: the change that names it may be on its way.
  const dir = join(home, 'backgrounds')
  await rt.backgroundSweep()
  assert.equal(readdirSync(dir).length, 2)
  const old = new Date(Date.now() - 60 * 60_000)
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old)
  await rt.backgroundSweep()
  assert.deepEqual(readdirSync(dir).map(name => name.slice(0, 64)), [used])
  assert.equal((await call('background-picture', { id: unused })).value, null)
  // Back to the team background.
  assert.equal((await call('set-chat-background', { botId: writer.id, background: null })).value, null)
})

test('the page stylesheet follows the appearance, and safe appearance drops the background and the user stylesheet', async () => {
  const { appearanceCss, backgroundPaint, leaveSafeAppearance, watchSafeAppearance, safeAppearance } = await import('../src/client/appearance.js')
  const { themesOf } = await import('../src/client/themes.js')
  const theme = themesOf({}).deepseek
  const appearance = { radius: 50, density: 'compact', fontSize: 16, uiFont: 'Inter', background: { kind: 'image', image: 'b'.repeat(64), blur: 8, dim: 30, surface: 80 }, css: '.x{color:red}' }
  const css = appearanceCss({ appearance, theme, pictureUrl: () => 'blob:picture', fonts: true })
  assert.match(css, /--bt-r:0\.5/)
  assert.match(css, /--bt-fs:1\.142/)
  assert.match(css, /--dsh-content-font-size:16px/)
  assert.match(css, /font-family:"Inter",-apple-system/)
  assert.match(css, /html body \.bt-row\{min-height:44px/)
  assert.match(css, /url\("blob:picture"\) center\/cover no-repeat/)
  assert.match(css, /filter:blur\(8px\)/)
  // One wash of the main color at the chosen opacity lies over the picture, over the dim veil;
  // the page panes on top are clear, so nested panes do not stack; floating surfaces stay
  // nearly solid. Both modes.
  assert.match(css, /html body\{--bt-pane:transparent;--bt-wash:rgba\(252,252,252,0\.8\);--bt-skin-main:rgba\(252,252,252,0\.94\);--bt-skin-sidebar:rgba\(247,247,247,0\.4\);--bt-skin-card:rgba\(255,255,255,0\.94\)\}/)
  assert.match(css, /html body::after\{[^}]*background:linear-gradient\(rgba\(252,252,252,0\.8\),rgba\(252,252,252,0\.8\)\),linear-gradient\(rgba\(255,255,255,0\.3\)/)
  assert.match(css, /html body\[data-ds-dark-theme\]::after\{background:linear-gradient\(rgba\(20,20,20,0\.8\)/)
  // The user stylesheet never joins the generated sheet's text: it reaches the page only
  // through the sanitized constructed stylesheet (theme-css.js, covered in theme-css.test).
  assert.doesNotMatch(css, /color:red/)
  // In DSH the font size is DSH's setting; the fonts go through DSH's own font variables too.
  const inDsh = appearanceCss({ appearance, theme })
  assert.doesNotMatch(inDsh, /--bt-fs/)
  assert.match(inDsh, /--dsh-font-family-text:"Inter"/)
  assert.match(inDsh, /font-family:"Inter",-apple-system/)
  // DS Bot's own surfaces read its own font variables, in DSH and in the desktop window
  // alike (where no DSH stylesheet sets DSH's).
  for (const sheet of [css, inDsh]) assert.match(sheet, /html body\{[^}]*--bt-font:"Inter",-apple-system/)
  const coded = appearanceCss({ appearance: { codeFont: 'JetBrains Mono' }, theme })
  assert.match(coded, /--bt-mono:"JetBrains Mono",ui-monospace/)
  assert.match(coded, /--dsh-font-family-code:"JetBrains Mono"/)
  // Code that DS Bot and the desktop window draw reads --bt-mono, not a stack of its own: a
  // stronger rule with fixed fonts would keep the chosen code font out.
  const { readFileSync } = await import('node:fs')
  const sheets = ['../../app/ui/src/app.css', '../src/client/learning-card.js', '../src/client/secret-card.js'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
  for (const rule of sheets.join('\n').match(/(?:\.md_markdown code|\.bt-learning-code|\.bt-secret-note code)[^{]*\{[^}]*\}/g)) assert.match(rule, /font-family:var\(--bt-mono\)/, rule)
  // A chat's own background takes the place of the team's.
  assert.match(appearanceCss({ appearance, theme, background: { kind: 'color', color: '#112233' } }), /background:#112233/)
  // A picture still loading paints nothing yet, so the surfaces stay solid.
  assert.doesNotMatch(appearanceCss({ appearance, theme }), /--bt-skin-main/)
  const safe = appearanceCss({ appearance, theme, pictureUrl: () => 'blob:picture', safe: true })
  assert.doesNotMatch(safe, /blob:picture|color:red/)
  assert.match(safe, /--bt-r:0\.5/)
  assert.equal(backgroundPaint({ kind: 'gradient', from: '#000000', to: '#ffffff', angle: 90 }), 'linear-gradient(90deg,#000000,#ffffff)')

  // Shift held on its own in the first seconds turns safe appearance on. Typing a capital,
  // a shortcut with another modifier, a quick tap, or a Shift pressed late does nothing.
  const target = new EventTarget()
  let clock = 0
  const timers = new Map()
  let ids = 0
  const wait = (fn) => { timers.set(++ids, fn); return ids }
  const unwait = id => timers.delete(id)
  // Fires the Shift holds; timer 1 is the one that closes the watch after the first seconds.
  const elapse = () => { for (const [id, fn] of Array.from(timers)) { if (id === 1) continue; timers.delete(id); fn() } }
  const key = (type, fields) => target.dispatchEvent(Object.assign(new Event(type), fields))
  const stop = watchSafeAppearance(target, () => clock, wait, unwait)
  key('keydown', { key: 'Shift', shiftKey: true })
  key('keydown', { key: 'A', shiftKey: true })
  elapse()
  assert.equal(safeAppearance(), false, 'typing a capital letter')
  key('keydown', { key: 'Shift', shiftKey: true, metaKey: true })
  elapse()
  assert.equal(safeAppearance(), false, 'a shortcut with another modifier')
  key('keydown', { key: 'Shift', shiftKey: true })
  key('keyup', { key: 'Shift' })
  assert.equal([...timers.values()].length, 1, 'a quick tap leaves only the closing timer')
  key('pointermove', { shiftKey: true, metaKey: true })
  assert.equal(safeAppearance(), false)
  clock = 3500
  key('keydown', { key: 'Shift', shiftKey: true })
  assert.equal([...timers.values()].length, 1, 'a Shift pressed after the first seconds starts no hold')
  clock = 0
  key('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
  elapse()
  assert.equal(safeAppearance(), true, 'Shift held on its own')
  stop()
  leaveSafeAppearance()
  // A Shift held from before the page loaded shows on the pointer (macOS does not repeat it).
  const again = watchSafeAppearance(target, () => 0, wait, unwait)
  key('pointermove', { shiftKey: true })
  assert.equal(safeAppearance(), true)
  again()
  leaveSafeAppearance()
  // Only the first move tells: Shift pressed afterwards to type while the mouse moves does not.
  const third = watchSafeAppearance(target, () => 0, wait, unwait)
  key('pointermove', {})
  key('pointermove', { shiftKey: true })
  assert.equal(safeAppearance(), false, 'Shift that came after the first move')
  third()
})

test('a background is let through only once it is painted: a picture loading or missing keeps the panes solid', async () => {
  const { backgroundShown } = await import('../src/client/appearance.js')
  const picture = { appearance: { background: { kind: 'image', image: 'c'.repeat(64) } } }
  assert.equal(backgroundShown({ ...picture, pictureUrl: () => undefined }), false)
  assert.equal(backgroundShown({ ...picture, pictureUrl: () => 'blob:x' }), true)
  assert.equal(backgroundShown({ ...picture, pictureUrl: () => 'blob:x', safe: true }), false)
  assert.equal(backgroundShown({ appearance: { background: { kind: 'color', color: '#112233' } } }), true)
})

test('font names are written quoted, one by one, and a comment opener is refused', async () => {
  const { fontStack } = await import('../src/shared/appearance.js')
  assert.equal(fontStack('"LXGW WenKai", Inter , sans-serif'), '"LXGW WenKai","Inter",sans-serif')
  assert.equal(fontStack('Odd"Name'), '"Odd\\"Name"')
  assert.throws(() => patchAppearance({}, { uiFont: 'Foo /* x' }), AppearanceError)
  assert.throws(() => patchAppearance({}, { codeFont: 'Bar */' }), AppearanceError)
})

test('corners and text sizes in DS Bot stylesheets follow the appearance; circles and pills keep their shape', async () => {
  const { scaleCss } = await import('../src/client/css-scale.js')
  const out = scaleCss('.a{border-radius:12px;font-size:13px;line-height:18px}.b{border-radius:50%}.c{border-radius:999px}.d{border-radius:16px 16px 0 0}.f{font:13px/1 x;max-width:600px}')
  assert.equal(out, '.a{border-radius:calc(12px*var(--bt-r,1));font-size:calc(13px*var(--bt-fs,1));line-height:calc(18px*var(--bt-fs,1))}.b{border-radius:50%}.c{border-radius:999px}.d{border-radius:calc(16px*var(--bt-r,1)) calc(16px*var(--bt-r,1)) 0 0}.f{font:13px/1 x;max-width:600px}')
  assert.equal(scaleCss(out), out)
})

test('a theme of your own is listed after the built-in ones, and a broken one is left out', async () => {
  const { themesOf } = await import('../src/client/themes.js')
  const themes = themesOf({ themes: { 'my-dusk': THEME, 'my-broken': { label: 'x', light: {}, dark: {} }, plain: THEME } })
  assert.equal(themes['my-dusk'].label, 'Dusk')
  assert.equal(themes['my-dusk'].own, true)
  assert.equal(themes['my-broken'], undefined)
  assert.equal(themes.plain, undefined)
  assert.ok(themes.deepseek)
})

test('a new background or text color moves the other surfaces with it, keeping the theme tint and its own bubble color', async () => {
  const { followBasics, themesOf, accentIn } = await import('../src/client/themes.js')
  const { contrast } = await import('../src/shared/appearance.js')
  const themes = themesOf({})
  // DeepSeek light on a warm paper: the sidebar and bubble stay a step towards the text,
  // the card a step away from it; your bubble follows the text, its text the background.
  const warm = followBasics(themes.deepseek.light, { bg: '#f7f4eb', text: '#1a1c1f' })
  assert.equal(warm.bg, '#f7f4eb')
  assert.equal(warm.text, '#1a1c1f')
  assert.equal(warm.card, '#faf7ee')
  assert.ok(warm.sidebar < warm.bg && warm.bubble < warm.sidebar)
  assert.equal(warm.user, '#1a1c1f')
  assert.equal(warm.userText, '#f7f4eb')
  assert.ok(contrast(warm.userText, warm.user) >= 4.5)
  // A light mode turned dark: the surfaces still sit between the new background and text.
  const night = followBasics(themes.deepseek.light, { bg: '#202020' , text: '#eeeeee' })
  assert.ok(night.sidebar > night.bg && night.bubble > night.sidebar && night.card < night.bg)
  // Moonlight's blue bubble keeps its color.
  const moon = followBasics(themes.moonlight.light, { bg: '#ffffff' })
  assert.equal(moon.user, themes.moonlight.light.user)
  assert.equal(moon.userText, themes.moonlight.light.userText)
  // The accent shown is the team's when one is picked, in its dark form in dark mode.
  assert.equal(accentIn(themes.deepseek, 'light', null), themes.deepseek.light.accent)
  assert.equal(accentIn(themes.deepseek, 'dark', '#123456'), '#123456')
})

test('a background and a text color set one after the other end as if set together', async () => {
  const { followBasics, moveBasics, themesOf } = await import('../src/client/themes.js')
  const { contrast } = await import('../src/shared/appearance.js')
  const light = themesOf({}).deepseek.light
  // The background is set first and passes close to the text; then the text is set.
  const first = moveBasics(light, { bg: '#202020' })
  const second = moveBasics(first, { text: '#eeeeee' })
  const together = followBasics(light, { bg: '#202020', text: '#eeeeee' })
  for (const key of ['bg', 'text', 'sidebar', 'bubble', 'card', 'user', 'userText']) assert.equal(second[key], together[key], key)
  assert.ok(contrast(second.user, second.userText) >= 4.5)
  // The accent is not moved.
  assert.equal(moveBasics({ ...light, accent: '#123456' }, { bg: '#202020' }).accent, '#123456')
  // Started from colors where the background already sits on the text, your bubble and its
  // text keep their own colors instead of both landing on one.
  const close = { ...light, bg: '#202020', text: '#1a1c1f', user: '#1a1c1f', userText: '#202020' }
  const moved = followBasics(close, { text: '#eeeeee' })
  assert.notEqual(moved.user, moved.userText)
})

test('the background and text move the surfaces from where they sat, also across saves; your bubble stays readable', async () => {
  const { followBasics, moveBasics, themesOf } = await import('../src/client/themes.js')
  const { cleanTheme } = await import('../src/shared/appearance.js')
  const themes = themesOf({})
  const light = themes.deepseek.light
  const together = followBasics(light, { bg: '#202020', text: '#eeeeee' })
  // The first change is saved and read back (the page closed in between); the base goes
  // with the colors through the host's rules.
  const first = cleanTheme({ label: 'x', light: moveBasics(light, { bg: '#202020' }), dark: themes.deepseek.dark }).light
  assert.deepEqual(Object.keys(first.base).sort(), ['bg', 'bubble', 'card', 'sidebar', 'text', 'user', 'userText'])
  const second = moveBasics(first, { text: '#eeeeee' })
  for (const key of ['sidebar', 'bubble', 'card', 'user', 'userText']) assert.equal(second[key], together[key], key)
  // A theme file goes without it: colors changed by hand in the file stay as written.
  const shared = themeFile({ label: 'x', light: first, dark: themes.deepseek.dark })
  assert.equal(shared.theme.light.base, undefined)
  assert.equal(readThemeFile(JSON.stringify({ ...shared, theme: { ...shared.theme, light: first } })).theme.light.base, undefined)
  // A base that is not whole is dropped, not trusted.
  assert.equal(cleanTheme({ label: 'x', light: { ...light, base: { bg: '#000000' } }, dark: light }).light.base, undefined)
  // Moonlight keeps its blue bubble; its text moves to the basic color that reads on it.
  for (const mode of ['light', 'dark']) {
    const colors = themes.moonlight[mode]
    for (const change of [{ bg: '#202020', text: '#eeeeee' }, { bg: '#f4f4f4', text: '#111111' }]) {
      const moved = followBasics(colors, change)
      assert.equal(moved.user, colors.user)
      assert.ok(contrast(moved.user, moved.userText) >= 3, `${mode} ${JSON.stringify(change)}`)
    }
  }
})

test('the Appearance page words are its own, not a word from another page that reads differently', async () => {
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../src/client/appearance-page.js', import.meta.url), 'utf8')
  const { DICTIONARY } = await import('../src/client/i18n.js')
  // Computer use's "Background", mail's "From" and "To", and the "Light" of an amount.
  for (const word of ['Background', 'From', 'To', 'Light']) {
    assert.doesNotMatch(page, new RegExp(`t\\('${word}'\\)|, '${word}'\\]`), word)
  }
  for (const word of ['Window background', 'Start color', 'End color', 'Light mode', 'Dark mode', 'Background color', 'Text color', 'More settings', 'Fewer settings']) {
    for (const lang of ['zh', 'ja', 'ko', 'es', 'fr', 'de']) assert.ok(Object.hasOwn(DICTIONARY[lang], word), `${lang}: ${word}`)
  }
})
