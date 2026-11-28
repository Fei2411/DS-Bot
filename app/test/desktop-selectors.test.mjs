import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { checkDesktopSelectors, scanFile } from '../../scripts/check-desktop-selectors.mjs'
import { SPRING_SETTLE } from '../../ds-bot/src/client/motion.js'
import { SHELL_CSS } from '../../ds-bot/src/client/styles.js'
import { teamActions } from '../../ds-bot/src/client/team-actions.js'
import { createSource } from '../../ds-bot/src/client/sources.js'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const APP_ROOT = join(REPO_ROOT, 'app')

test('check-desktop-selectors passes on the real desktop import graph with 0 violations', () => {
  const result = checkDesktopSelectors({ rootDir: REPO_ROOT })
  assert.ok(result.files.length > 50, 'should traverse desktop + shared client graph')
  assert.deepEqual(result.violations, [])
})

test('check-desktop-selectors catches DSH-private selectors/vars, ignores comments, and exempts *-dsh.js', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-sel-guard-'))
  try {
    mkdirSync(join(dir, 'app', 'ui', 'src'), { recursive: true })
    mkdirSync(join(dir, 'ds-bot', 'src', 'client'), { recursive: true })
    writeFileSync(join(dir, 'app', 'ui', 'src', 'main.js'), [
      "import './clean.js'",
      "import './bad.js'",
      "import './styles-dsh.js'",
    ].join('\n'))
    writeFileSync(join(dir, 'app', 'ui', 'src', 'clean.js'), [
      '// comment mentioning [class*="_centerCol"] and --dsh-composer-height is ignored',
      '/* block comment with data-composer-card and data-slot="x" is ignored */',
      'export const sel = "[data-bt-scroll] [data-bt-composer] var(--bt-composer-h)"',
    ].join('\n'))
    writeFileSync(join(dir, 'app', 'ui', 'src', 'bad.js'), [
      'export const a = "[class*=\\"_centerCol\\"]"',
      'export const b = "[data-chat-following-tail]"',
      'export const c = "[data-composer-card]"',
      'export const d = "[data-conversation-scroll]"',
      'export const e = "[data-slot=\\"main\\"]"',
      'export const f = "[role=textbox][contenteditable=true]"',
      'export const g = "var(--dsh-composer-height)"',
      'export const h = "dsb_centerCol"',
    ].join('\n'))
    // Plugin-only file exempted by `*-dsh.js` naming convention.
    writeFileSync(join(dir, 'app', 'ui', 'src', 'styles-dsh.js'), 'export const css = "[class*=\\"_header\\"]{height:var(--dsh-composer-height)}"')

    const result = checkDesktopSelectors({ entry: join(dir, 'app', 'ui', 'src', 'main.js'), rootDir: dir })
    assert.ok(result.files.some(f => f.endsWith('app/ui/src/styles-dsh.js')))
    assert.ok(result.files.some(f => f.endsWith('app/ui/src/clean.js')))
    assert.equal(result.violations.filter(v => v.file === 'app/ui/src/clean.js').length, 0)
    assert.equal(result.violations.filter(v => v.file === 'app/ui/src/styles-dsh.js').length, 0)
    const badIds = new Set(result.violations.filter(v => v.file === 'app/ui/src/bad.js').map(v => v.rule))
    for (const id of [
      'dsh-class-fragment',
      'dsh-data-chat',
      'dsh-data-composer',
      'dsh-data-scroll',
      'dsh-data-slot',
      'dsh-textbox-contenteditable',
      'dsh-css-var',
      'dsh-centercol-shim',
    ]) {
      assert.ok(badIds.has(id), `expected rule ${id} to be detected`)
    }
    assert.equal(scanFile(join(dir, 'app', 'ui', 'src', 'clean.js'), dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2416 toggleDetails sets panelYield when opening on a narrow viewport where the panel would fold', () => {
  const roster = createSource({ byId: { b1: { id: 'b1', name: 'Bot' } }, roomsById: {} })
  const ui = createSource({ details: null, view: 'details', panelYield: false, leftDrawer: false })
  const live = createSource({})
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  const actions = teamActions({
    call: async () => ({}),
    after: p => p,
    partFor: id => id,
    roster,
    ui,
    live,
    cards,
    heldCards,
    turnClock,
    panelFolded: () => true,
  })

  // Opening details from closed state on a narrow window must set panelYield: true.
  actions.toggleDetails('b1')
  assert.equal(ui.getSnapshot().details, 'b1')
  assert.equal(ui.getSnapshot().view, 'details')
  assert.equal(ui.getSnapshot().panelYield, true)

  // Clicking again while already yielded closes details cleanly.
  const actionsUnfolded = teamActions({
    call: async () => ({}),
    after: p => p,
    partFor: id => id,
    roster,
    ui,
    live,
    cards,
    heldCards,
    turnClock,
    panelFolded: () => false,
  })
  actionsUnfolded.toggleDetails('b1')
  assert.equal(ui.getSnapshot().details, null)
})

test('#2412 SPRING_SETTLE has zero overshoot and app.css clips root overflow', () => {
  const samples = SPRING_SETTLE.easing.match(/linear\(([^)]+)\)/)?.[1]?.split(',').map(Number) ?? []
  assert.ok(samples.length === 25, 'SPRING_SETTLE should have 25 samples')
  for (let i = 0; i < samples.length; i += 1) {
    assert.ok(samples[i] <= 1.0001, `sample ${i} (${samples[i]}) must not overshoot 1`)
    if (i > 0) assert.ok(samples[i] >= samples[i - 1] - 0.0001, `sample ${i} must be monotonic`)
  }
  assert.match(SHELL_CSS, new RegExp(`\\[data-bt-center\\]\\{transition:margin-right ${SPRING_SETTLE.duration}ms`))
  const appCss = readFileSync(join(APP_ROOT, 'ui', 'src', 'app.css'), 'utf8')
  assert.match(appCss, /html,body,#root\{height:100%;margin:0;overflow:hidden\}/)
})

test('ComposerVoice quote-reply focuses desktop <textarea data-bt-composer-input> and places caret at end', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { ComposerVoice } from '../ds-bot/src/client/composer.js'",
      resolveDir: APP_ROOT,
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    external: ['react'],
  })
  const effects = []
  const refs = []
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useRef: init => { const r = { current: init }; refs.push(r); return r },
    useEffect: (fn) => { effects.push(fn) },
    useLayoutEffect: (fn) => { effects.push(fn) },
    useMemo: fn => fn(),
    useCallback: fn => fn,
  }
  let focused = false
  let selRange = null
  const textarea = {
    value: '> quoted text\n\n',
    focus() { focused = true },
    setSelectionRange(start, end) { selRange = [start, end] },
  }
  const card = {
    querySelector: sel => (sel === '[data-bt-composer-input]' ? textarea : null),
    addEventListener() {},
    removeEventListener() {},
  }
  const btn = { closest: sel => (sel === '[data-bt-composer]' ? card : null) }
  const inserted = []
  let clearedToken = null
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    require: () => react,
    document: { querySelector: () => null },
    window: { getSelection: () => null },
    HTMLElement: class {},
    setTimeout,
    clearTimeout,
  })
  mod.exports.ComposerVoice({
    sessionId: 'b1',
    inputActions: {
      captureInsertion: () => ({ start: 0, end: 0 }),
      insertText: (text) => { inserted.push(text) },
    },
    actions: {
      speech: () => undefined,
      hasPluginMic: () => false,
      clearQuote: (token) => { clearedToken = token },
      openVoice() {},
    },
    useUi: pick => pick({ quote: { sessionId: 'b1', text: 'quoted text', token: 42 } }),
    useRoster: pick => pick({ prefs: { enterToSend: true } }),
    voiceChat: true,
    disabled: false,
  })
  // Attach composerRoot ref (first ref in ComposerVoice) before running effects.
  refs[0].current = btn
  for (const fn of effects) fn()
  assert.equal(clearedToken, 42)
  assert.deepEqual(inserted, ['> quoted text\n\n'])
  assert.equal(focused, true, 'quote-reply must focus desktop textarea')
  assert.deepEqual(selRange, [textarea.value.length, textarea.value.length])
})
