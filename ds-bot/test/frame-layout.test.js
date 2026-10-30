import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RAIL_WIDTH, RAIL_SNAP, SIDEBAR_MIN, SIDEBAR_MAX, MIN_CHAT, FALLBACK_SIDEBAR_WIDTH,
  frameLayout, dragColumn, toggledPref, userSidebarToggle, readSidebar, writeSidebar,
} from '../src/client/frame-layout.js'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

// The window, the shell sidebar's track width and what is open decide which left
// column shows and how the Bot panel sits; the chat keeps MIN_CHAT.
const at = (viewport, sidebarWidth, { pref = 'open', drawer = false, panel = null } = {}) =>
  frameLayout({ viewport, sidebarWidth, pref, drawer, panel })
const details = (yielded = false) => ({ view: 'details', yielded })
const browser = (yielded = false) => ({ view: 'browser', yielded })

test('a wide window keeps the open column and a shown panel', () => {
  const layout = at(1400, 280, { panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'open', panel: 'shown' })
  assert.equal(layout.room, 1400 - 280)
})

test('the panel folds when column, panel and chat together do not fit', () => {
  // 280 + 320 + 420 = 1020 > 1000.
  const layout = at(1000, 280, { panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'open', panel: 'folded' })
})

test('a yielded panel gets its room back from the rail', () => {
  // 88 + 320 + 420 = 828 <= 1000.
  const layout = at(1000, 280, { panel: details(true) })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'rail', panel: 'shown' })
  assert.equal(layout.room, 1000 - RAIL_WIDTH)
})

test('a yielded browser panel shows beside the rail, and only covers the chat below its minimum', () => {
  // 88 + 360 + 420 = 868.
  assert.equal(at(1000, 280, { panel: browser(true) }).panel, 'shown')
  const layout = at(760, 280, { panel: browser(true) })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'rail', panel: 'overlay' })
})

test('without a panel the column stays open while the chat fits, then folds to the rail', () => {
  // 280 + 420 = 700 <= 800, > 690.
  assert.equal(at(800, 280).left, 'open')
  assert.equal(at(800, 280).room, 800 - 280)
  assert.equal(at(690, 280).left, 'rail')
  assert.equal(at(690, 280).room, 690 - RAIL_WIDTH)
  assert.equal(at(690, 280, { drawer: true }).left, 'drawer')
  // A drawer floats over the rail's place: the chat keeps the room it had beside the rail.
  assert.equal(at(690, 280, { drawer: true }).room, 690 - RAIL_WIDTH)
})

test('a rail preference keeps the rail beside a shown panel', () => {
  const layout = at(1400, 280, { pref: 'rail', panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'rail', panel: 'shown' })
  assert.equal(layout.room, 1400 - RAIL_WIDTH)
})

test('a sidebar widened in Agent mode still folds the panel first', () => {
  // 420 + 320 + 420 = 1160 > 1100.
  const layout = at(1100, 420, { panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'open', panel: 'folded' })
})

test('a folded panel in a drawer window keeps the drawer until the panel yields it', () => {
  const layout = at(690, 280, { drawer: true, panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'drawer', panel: 'folded' })
  assert.equal(at(690, 280, { drawer: true, panel: details(true) }).left, 'rail')
})

test('an unknown panel view folds by the details minimum', () => {
  assert.equal(at(1000, 280, { panel: { view: 'mystery', yielded: false } }).panel, 'folded')
})

// The switch hides the whole column: nothing is left beside the chat.
test('a hidden column takes no room, and a panel shows or covers beside nothing', () => {
  const layout = at(1000, 280, { pref: 'hidden', panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel, room: layout.room }, { left: 'hidden', panel: 'shown', room: 1000 })
  assert.equal(at(600, 280, { pref: 'hidden', panel: details() }).panel, 'folded')
  assert.deepEqual(at(600, 280, { pref: 'hidden', panel: details(true) }), { left: 'hidden', panel: 'overlay', room: 600 })
})

test('the switch hides the column and brings back the one it hid', () => {
  assert.equal(toggledPref('open', 'open'), 'hidden')
  assert.equal(toggledPref('rail', 'rail'), 'hidden')
  assert.equal(toggledPref('hidden', 'rail'), 'rail')
  assert.equal(toggledPref('hidden', 'open'), 'open')
})

// The edge drag: a width in the open range, docked while the chat keeps its
// room; short of the snap point the rail.
test('a drag short of the snap point lands on the rail', () => {
  assert.deepEqual(dragColumn(RAIL_SNAP - 1, 1400), { left: 'rail', width: RAIL_WIDTH })
  assert.deepEqual(dragColumn(30, 1400), { left: 'rail', width: RAIL_WIDTH })
})

test('a drag past the snap point opens a column within its width range', () => {
  assert.deepEqual(dragColumn(RAIL_SNAP, 1400), { left: 'open', width: SIDEBAR_MIN })
  assert.deepEqual(dragColumn(333.4, 1400), { left: 'open', width: 333 })
  assert.deepEqual(dragColumn(900, 1400), { left: 'open', width: SIDEBAR_MAX })
  // The chat keeps MIN_CHAT beside a docked column.
  assert.deepEqual(dragColumn(400, 800), { left: 'open', width: 800 - MIN_CHAT })
})

test('a drag past the snap point on a window too narrow to dock floats a drawer', () => {
  assert.deepEqual(dragColumn(300, 600), { left: 'drawer', width: 300 })
  assert.deepEqual(dragColumn(500, 600), { left: 'drawer', width: SIDEBAR_MAX })
})

test('the saved column reads back, and anything unknown falls back to the open default', () => {
  const store = new Map()
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.deepEqual(readSidebar(storage), { pref: 'open', shown: 'open', width: FALLBACK_SIDEBAR_WIDTH })
  writeSidebar({ pref: 'hidden', shown: 'rail', width: 350 }, storage)
  assert.deepEqual(readSidebar(storage), { pref: 'hidden', shown: 'rail', width: 350 })
  writeSidebar({ pref: 'odd', shown: 'odd', width: 9999 }, storage)
  assert.deepEqual(readSidebar(storage), { pref: 'open', shown: 'open', width: SIDEBAR_MAX })
  store.set('ds-bot:sidebar', 'rail')
  assert.deepEqual(readSidebar(storage), { pref: 'open', shown: 'open', width: FALLBACK_SIDEBAR_WIDTH })
})

// A flip of the shell's collapsed flag is the user's switch gesture only when we
// did not request it and the window stayed on one side of the auto-collapse line.
test('a sidebar flip we requested is not a user toggle', () => {
  const before = { collapsed: false, viewport: 1400 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: true, viewport: 1400 }, requested: true }), false)
})

test('a flip across the auto-collapse line is the shell rule, not a gesture', () => {
  const before = { collapsed: false, viewport: 1100 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: true, viewport: 1000 } }), false)
})

test('a flip right after a width change is the shell settling, not a gesture', () => {
  const before = { collapsed: true, viewport: 1386 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: false, viewport: 1386 }, sinceResize: 120 }), false)
  assert.equal(userSidebarToggle({ before, after: { collapsed: false, viewport: 1386 }, sinceResize: 800 }), true)
})

test('an unrequested flip on one side of the line is the user', () => {
  const before = { collapsed: false, viewport: 1400 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: true, viewport: 1300 } }), true)
  assert.equal(userSidebarToggle({ before: { collapsed: true, viewport: 800 }, after: { collapsed: false, viewport: 700 } }), true)
})

// A folded panel is open but not shown. The panel following the chat to another
// subject is not the user asking to see it; the openers are.
const bench = (folded, panelYield = false) => {
  const ui = createSource({ details: 'chief', view: 'details', renaming: false, tab: null, side: null, panelYield, leftDrawer: false })
  const roster = createSource({ byId: { chief: { id: 'chief' }, writer: { id: 'writer' } }, roomsById: {}, sideChats: {} })
  const actions = teamActions({
    call: () => Promise.resolve(null), after: promise => promise, partFor: id => id,
    roster, ui, panelFolded: () => folded,
  })
  return { ui, actions }
}

test('the folded panel does not resurface when it follows the chat elsewhere', () => {
  const { ui, actions } = bench(true)
  actions.followPanel('writer')
  assert.equal(ui.getSnapshot().details, 'writer')
  assert.equal(ui.getSnapshot().panelYield, false)
})

test('explicit openers on the folded panel yield the column to it', () => {
  const { ui, actions } = bench(true)
  actions.showDetails('writer')
  assert.equal(ui.getSnapshot().panelYield, true)
  ui.set(state => ({ ...state, panelYield: false }))
  actions.openSideChat('chief', 'chat-1')
  assert.equal(ui.getSnapshot().panelYield, true)
})

test('openers on a panel that fits do not yield', () => {
  const { ui, actions } = bench(false)
  actions.showDetails('writer')
  assert.equal(ui.getSnapshot().panelYield, false)
})

// A panel shown because the column yielded is not folded: its opener closes it,
// and the other openers keep the yield it already has.
test('the opener closes a panel the column yielded to', () => {
  const { ui, actions } = bench(false, true)
  actions.toggleDetails('chief')
  assert.equal(ui.getSnapshot().details, null)
})

test('openers keep a yield already given', () => {
  const { ui, actions } = bench(false, true)
  actions.showDetails('writer')
  assert.equal(ui.getSnapshot().panelYield, true)
  actions.setPanelView('side')
  assert.equal(ui.getSnapshot().panelYield, true)
})
