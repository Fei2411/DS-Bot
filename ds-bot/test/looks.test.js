import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CHARACTERS, DEFAULT_COLORS, DEFAULT_SHAPES, MAIN_LOOK, PICKER_SHAPES, SHAPE_ALIASES, SHAPES, characterMarkup, defaultColor, defaultShape, hasShape, lookOf, maskOf, resolveShape, shapeId } from '../src/client/characters.js'
import { indexRoster } from '../src/client/sources.js'
import { registerShape } from '../src/client/themes.js'

const ids = Array.from({ length: 3000 }, (_, index) => `session-${index.toString(16).padStart(8, '0')}-look`)

test('a Bot with no look of its own never gets the whale, gray, brown, or black', () => {
  assert.ok(!DEFAULT_SHAPES.includes('whale'))
  assert.equal(DEFAULT_SHAPES.length, 15)
  // Surviving default slots stay at their original indices so existing Bots keep their shapes.
  for (const [index, id] of [[0, 'star'], [1, 'moon'], [3, 'octopus'], [10, 'gumdrop'], [11, 'peanut'], [12, 'bunny'], [13, 'kitty'], [14, 'acorn']]) {
    assert.equal(DEFAULT_SHAPES[index], id)
  }
  for (const color of ['gray', 'brown', 'black', 'aurora']) assert.ok(!DEFAULT_COLORS.includes(color), color)
  const shapes = new Set(ids.map(defaultShape))
  const colors = new Set(ids.map(defaultColor))
  assert.deepEqual([...shapes].sort(), [...DEFAULT_SHAPES].sort())
  assert.deepEqual([...colors].sort(), [...DEFAULT_COLORS].sort())
})

test('redesigned characters render flat 3/4 silhouettes, keep a 20-shape picker, and alias replaced keys', () => {
  assert.equal(PICKER_SHAPES.length, 20)
  for (const retired of ['zed', 'wave', 'hex', 'cushion', 'ring', 'gem', 'magnet', 'dolphin', 'turtle', 'crab', 'puffer', 'jelly', 'starfish', 'seahorse']) {
    assert.ok(!PICKER_SHAPES.includes(retired), `${retired} should stay out of PICKER_SHAPES`)
  }
  for (const added of ['moon', 'cloud', 'spark', 'bear', 'puppy', 'octopus', 'sprout', 'bloom', 'squircle']) {
    assert.ok(PICKER_SHAPES.includes(added), `${added} should appear in PICKER_SHAPES`)
    assert.ok(Object.hasOwn(SHAPES, added), `${added} should exist in SHAPES`)
    const markup = characterMarkup(added, 'blue')
    assert.ok(!markup.includes('fill-opacity=".07"'), `${added} should not render a fake-3D shade overlay`)
  }
  const expectedAliases = {
    zed: 'bear',
    wave: 'octopus',
    hex: 'bloom',
    cushion: 'squircle',
    dolphin: 'whale',
    turtle: 'acorn',
    crab: 'octopus',
    puffer: 'cloud',
    jelly: 'octopus',
    starfish: 'star',
    seahorse: 'whale',
  }
  assert.deepEqual(SHAPE_ALIASES, expectedAliases)
  for (const [legacy, target] of Object.entries(expectedAliases)) {
    assert.equal(hasShape(legacy), true)
    assert.equal(shapeId(legacy), target)
    assert.equal(lookOf({ id: 'old-bot', avatar: { shape: legacy } }).shape, target)
    assert.equal(characterMarkup(legacy, 'orange'), characterMarkup(target, 'orange'))
    assert.equal(maskOf(legacy), maskOf(target))
  }
  // Legacy non-vendor shapes stay renderable for Bots that already saved them.
  for (const kept of ['ring', 'gem', 'magnet']) {
    assert.equal(hasShape(kept), true)
    assert.equal(lookOf({ id: 'legacy-bot', avatar: { shape: kept } }).shape, kept)
  }
  // The desktop start-window rig reads whale.shade and whale.light directly.
  assert.ok(CHARACTERS.whale.shade && CHARACTERS.whale.light)
  assert.ok(!characterMarkup('whale', 'deepseek').includes('fill-opacity=".07"'))
})

test('custom registered shapes override alias names and refresh alias masks', () => {
  const originalOctopusMask = maskOf('wave')
  assert.equal(originalOctopusMask, maskOf('octopus'))
  const unregisterWave = registerShape('wave', {
    label: 'Custom Wave',
    body: paint => `<circle cx="50" cy="50" r="40" fill="${paint}"/>`,
    eyes: { at: [[40, 45], [60, 45]] },
  })
  try {
    assert.equal(resolveShape('wave'), 'wave')
    assert.equal(shapeId('wave'), 'wave')
    assert.equal(lookOf({ id: 'custom-bot', avatar: { shape: 'wave' } }).shape, 'wave')
    assert.ok(characterMarkup('wave', 'blue').includes('<circle cx="50" cy="50" r="40"'))
    assert.notEqual(maskOf('wave'), originalOctopusMask)
  } finally {
    unregisterWave()
  }
  assert.equal(resolveShape('wave'), 'octopus')
  assert.equal(maskOf('wave'), originalOctopusMask)

  // Re-registering an alias target invalidates the shared resolved mask cache.
  const unregisterOctopus = registerShape('octopus', {
    label: 'Custom Octopus',
    body: paint => `<rect x="10" y="10" width="80" height="80" fill="${paint}"/>`,
    eyes: { at: [[40, 45], [60, 45]] },
  })
  try {
    const updatedMask = maskOf('octopus')
    assert.notEqual(updatedMask, originalOctopusMask)
    assert.equal(maskOf('wave'), updatedMask)
  } finally {
    unregisterOctopus()
  }
  assert.equal(maskOf('wave'), originalOctopusMask)
})

const roster = (bots, mainBotIds) => indexRoster({ bots, rooms: [], mainBotIds, mainBotId: mainBotIds[0] ?? null })

test('the whale is only a stored look: the browser gives no Bot a look by its place in the team', () => {
  const chief = { id: 'chief', name: 'Chief', createdAt: 1, color: 'deepseek', avatar: { shape: 'whale' } }
  const writer = { id: 'writer', name: 'Writer', createdAt: 2 }
  assert.deepEqual(lookOf(roster([writer, chief], ['chief']).byId.chief), { ...MAIN_LOOK, image: undefined })
  // The first Main Bot left, with no stored look, keeps the look its id gives it.
  const left = roster([writer], ['writer']).byId.writer
  assert.deepEqual(lookOf(left), { shape: defaultShape('writer'), color: defaultColor('writer'), image: undefined })
  const photo = lookOf({ id: 'chief', avatar: { image: 'data:image/png;base64,AA==' } })
  assert.equal(photo.image, 'data:image/png;base64,AA==')
  assert.equal(photo.shape, defaultShape('chief'))
})

test('Bot settings is the only settings entry; nothing is called Team settings', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const sources = readdirSync(dir).filter(name => name.endsWith('.js')).map(name => [name, readFileSync(new URL(name, dir), 'utf8')])
  for (const [name, text] of [...sources, ['client.js', readFileSync(new URL('../client.js', import.meta.url), 'utf8')]]) {
    assert.ok(!text.includes('Team settings'), `${name} still names Team settings`)
  }
  const text = name => sources.find(([file]) => file === name)[1]
  assert.match(text('sidebar.js'), /\[t\('Settings'\), GearIcon, \(\) => actions\.openSettings\('overview'\)\]/)
  assert.match(text('palette.js'), /title: t\('Settings'\), run: \(\) => actions\.openSettings\('overview'\)/)
  // One Bot's own entries open that Bot, so they read Edit Bot instead.
  assert.match(text('context-menu.js'), /\[t\('Edit Bot'\), GearIcon, \(\) => actions\.openSettings\('bots', bot\.id\)\]/)
  assert.match(text('details-drawer.js'), /'aria-label': bot \? t\('Edit Bot'\) : t\('Group settings'\), title: bot \? t\('Edit Bot'\) : t\('Group settings'\)/)
  // A group chat's entries open its own settings the same way.
  assert.match(text('context-menu.js'), /\[t\('Group settings'\), GearIcon, \(\) => actions\.openSettings\('groups', room\.id\)\]/)
  assert.ok(!text('mark.js').includes('WhaleLogo'))
})
