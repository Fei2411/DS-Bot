import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checks, findViolations, lowered, readDebt, stripComments } from '../scripts/ui-architecture-guard.mjs'

const found = findViolations()
const debt = readDebt()

function drift(kind) {
  const lines = []
  for (const file of new Set([...Object.keys(found[kind]), ...Object.keys(debt[kind] ?? {})])) {
    const now = found[kind][file] ?? {}
    const was = debt[kind]?.[file] ?? {}
    for (const value of new Set([...Object.keys(now), ...Object.keys(was)])) {
      const more = (now[value] ?? 0) - (was[value] ?? 0)
      if (more > 0) lines.push(`${file}: ${value}, ${more} new`)
      if (more < 0) lines.push(`${file}: ${value}, ${-more} gone; run node scripts/ui-architecture-guard.mjs --write`)
    }
  }
  return lines
}

function check(kind, advice) {
  const lines = drift(kind)
  assert.equal(lines.length, 0, `${lines.join('\n')}\n${advice}`)
}

test('switches compose from ui/controls.js', () => {
  check('switches', 'Use Switch or SwitchRow from ds-bot/src/client/ui/controls.js instead of a bare role="switch".')
})

test('sliders compose from ui/slider.js', () => {
  check('sliders', 'Use Slider from ds-bot/src/client/ui/slider.js instead of a bare range input or role="slider".')
})

test('dropdown selects compose from ui/controls.js', () => {
  check('selects', 'Use SelectMenu or Choice from ds-bot/src/client/ui/controls.js instead of a bare native <select>.')
})

test('centered modals compose from ui/dialog.js', () => {
  check('dialogs', 'Use Dialog from ds-bot/src/client/ui/dialog.js instead of a new hand-rolled role="dialog".')
})

test('interactive and settled cards compose from ui/card.js', () => {
  check('cards', 'Use ActionCard or SettledCard from ds-bot/src/client/ui/card.js instead of a bare bt-q-raised/dock/settled shell.')
})

test('top notices and banners live inside DynamicIsland', () => {
  check('topBanners', 'Mount top banners and notices as pods/notices inside DynamicIsland (ds-bot/src/client/ui/island.js).')
})

test('no new ad-hoc cubic-bezier curves outside motion.js', () => {
  check('curves', 'Use SPRING_* constants from ds-bot/src/client/motion.js (or ease/ease-out for color/opacity) instead of raw cubic-bezier().')
})

test('guard detectors catch disallowed patterns and allow canonical carriers', () => {
  assert.deepEqual(checks.switches('ds-bot/src/client/foo.js', "h('button', { role: 'switch' })"), ["role:'switch'"])
  assert.deepEqual(checks.switches('ds-bot/src/client/ui/controls.js', "h('button', { role: 'switch' })"), [])
  assert.deepEqual(checks.sliders('ds-bot/src/client/foo.js', "h('input', { type: 'range' })"), ["type:'range'"])
  assert.deepEqual(checks.sliders('ds-bot/src/client/ui/slider.js', "h('div', { role: 'slider' })"), [])
  assert.deepEqual(checks.selects('app/ui/src/foo.js', "h('select', {})"), ["h('select')"])
  assert.deepEqual(checks.selects('app/ui/src/foo.js', "createElement('select', {})"), ["h('select')"])
  assert.deepEqual(checks.selects('ds-bot/src/client/ui/controls.js', "h('select', {})"), [])
  assert.deepEqual(checks.dialogs('app/ui/src/foo.js', "h('div', { role: 'dialog' })"), ["role:'dialog'"])
  assert.deepEqual(checks.dialogs('app/ui/src/foo.js', "h('div', { role: 'alertdialog' })"), ["role:'alertdialog'"])
  assert.deepEqual(checks.dialogs('app/ui/src/foo.js', "el.closest('[role=\"dialog\"]')"), [])
  assert.deepEqual(checks.dialogs('ds-bot/src/client/ui/dialog.js', "h('div', { role: 'dialog' })"), [])
  assert.deepEqual(checks.cards('app/ui/src/foo.js', "h('div', { className: 'bt-q bt-q-raised' })"), ['bt-q-raised'])
  assert.deepEqual(checks.cards('app/ui/src/foo.js', "h('div', { className: inline ? 'bt-q-inline' : 'bt-q-dock' })"), ['bt-q-dock'])
  assert.deepEqual(checks.cards('ds-bot/src/client/ui/card.js', "h('div', { className: 'bt-q bt-q-raised' })"), [])
  assert.deepEqual(checks.sliders('app/ui/src/foo.js', "el.closest('[role=\"slider\"]')"), [])
  assert.equal(stripComments("const url = 'https://example.com' /* inline */ + 1 // tail\n/* multi\nline */const x = 2"), "const url = 'https://example.com'   + 1 \n\n const x = 2")
  assert.deepEqual(checks.topBanners('app/ui/src/app.css', '.dsb-conn-banner{top:0}'), ['dsb-conn-banner'])
  assert.deepEqual(checks.curves('ds-bot/src/client/foo.js', 'transition:transform .2s cubic-bezier(.2,0,0,1)'), ['cubic-bezier(.2,0,0,1)'])
  assert.deepEqual(checks.curves('ds-bot/src/client/motion.js', 'cubic-bezier(.2,0,0,1)'), [])
  assert.deepEqual(
    lowered({ switches: { 'a.js': { "role:'switch'": 2 } }, sliders: {}, selects: {}, dialogs: {}, cards: {}, topBanners: {}, curves: {} }, { switches: { 'a.js': { "role:'switch'": 1 } }, sliders: {}, selects: {}, dialogs: {}, cards: {}, topBanners: {}, curves: {} }).switches,
    { 'a.js': { "role:'switch'": 1 } },
  )
})
